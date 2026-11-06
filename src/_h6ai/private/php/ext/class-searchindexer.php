<?php
declare(strict_types=1);

// Builds and refreshes the search index (see docs/SEARCH.md, SearchIndex for the files).
//
// Full build: depth first over the tree with an explicit stack stored in the database, so it
// can run in slices and resume. Ids are assigned in pre-order: every folder's subtree is the id
// range (id, hi], which is what scoped searches and permission pruning use.
//
// Refresh pass: visits every folder (path order, a cursor in meta, resumable). A folder whose
// mtime/ctime didn't change is skipped: a pass over an unchanged tree costs one stat per folder.
// Changed folders are re-listed and diffed by name. Folders that disappear are detached (their
// subtree moves below a "#<id>/" path, outside every search scope) and reattached if the same
// device+inode shows up elsewhere (a rename or move: the subtree keeps its ids, nothing is
// re-indexed). Detached subtrees still left at the end of a pass are deleted in chunks.
//
// What's indexed follows the listing rules without permissions and readability (both are
// applied per user and live at query time; a chmod doesn't change the parent folder, so the
// index couldn't follow it): view.hidden on names and hrefs, _h6ai/_h5ai, view.unmanaged and
// nested installs (folder listed, not descended). A symlinked folder is descended once if it
// leads out of the tree (another disk mounted in by a link); links back into the tree, loops and
// a second link to the same place are listed, not descended.
final class SearchIndexer {
    private const COMMIT_SECONDS = 0.5;
    private const BATCH = 256;
    private const CHUNK = 5000;
    private const REBUILD_DELTA_MIN = 100000;
    private const REBUILD_DELTA_RATIO = 0.25;
    private const KIND_OPEN = 1;
    private const KIND_CLOSE = 2;

    private ?PDO $db = null;
    private float $last_commit = 0.0;
    private array $stats = [];
    private string $root_path;
    private string $h6ai_path;
    private array $unmanaged;
    private int $max_entries;
    private int $max_depth;
    private array $stmt = [];
    private ?array $link_targets = null; // real path "/x/y/" => node id of the linked folders descended
    private ?string $root_real = null;
    private $log;
    private $progress;

    public function __construct(
        private readonly Context $context,
        private readonly SearchIndex $index,
        ?callable $log = null,
        ?callable $progress = null
    ) {
        $setup = $context->get_setup();
        $this->root_path = (string) $setup->get('ROOT_PATH');
        $this->h6ai_path = (string) $setup->get('H6AI_PATH');
        $this->unmanaged = array_values(array_filter((array) $context->query_option('view.unmanaged', []), 'is_string'));
        $this->max_entries = $index->max_entries();
        $this->max_depth = $index->max_depth();
        $this->log = $log;
        $this->progress = $progress;
    }

    private function log(string $msg): void {
        if ($this->log !== null) {
            ($this->log)($msg);
        }
    }

    // Does index work for at most $seconds. $mode: "auto" (whatever is due), "refresh" (a pass
    // now), "verify" (a pass that re-lists every folder), "rebuild". $bulk: one uninterrupted
    // run (CLI): secondary indexes and the full-text index are created after loading, which is
    // several times faster, but can't be resumed.
    public function run(float $seconds, string $mode = 'auto', bool $bulk = false): array {
        $support = SearchIndex::support();
        if (!$support['ok']) {
            return ['did' => 'unsupported', 'msg' => $support['reason']];
        }
        if (!$this->index->ensure_dir()) {
            return ['did' => 'error', 'msg' => 'cannot write ' . $this->index->dir()];
        }
        $lock = @fopen($this->index->dir() . '/writer.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            if ($lock !== false) {
                fclose($lock);
            }
            return ['did' => 'busy'];
        }
        $deadline = microtime(true) + $seconds;
        $this->stats = ['folders' => 0, 'rescanned' => 0, 'changes' => 0];
        try {
            clearstatcache(true);
            $this->index->cleanup();
            $request_file = $this->index->dir() . '/rebuild.request';
            $want_rebuild = $mode === 'rebuild' || is_file($request_file);
            $hard = $this->index->hard_fingerprint();
            $soft = $this->index->soft_fingerprint();

            $building = $this->index->building();
            // A bulk build is never resumed (we hold the writer lock, so its process is gone), and
            // a build for another configuration is useless.
            if ($building && (!empty($building['bulk']) || $building['hard'] !== $hard || $building['soft'] !== $soft)) {
                $this->log('discarding unfinished build of generation ' . $building['gen']);
                $this->index->remove_gen($building['gen']);
                $this->index->set_building(null);
                $building = null;
            }
            if ($building === null) {
                $current = $this->index->current();
                $reason = $want_rebuild ? 'requested' : ($current === null ? 'no index' : null);
                if ($reason === null && ($current['hard'] !== $hard || $current['soft'] !== $soft)) {
                    $reason = 'configuration changed';
                }
                if ($reason === null && $this->rebuild_due($current)) {
                    $reason = 'many changes since the last build';
                }
                if ($reason !== null) {
                    $building = $this->start_build($hard, $soft, $bulk, $reason);
                    @unlink($request_file);
                }
            }
            if ($building !== null) {
                $done = $this->build($building, $deadline);
                return ['did' => 'build', 'done' => $done, 'gen' => $building['gen']] + $this->stats;
            }

            $current = $this->index->current();
            $this->db = $this->index->open($current['gen'], false);
            $this->link_targets = null;
            $this->writer_pragmas(false);
            $meta = SearchIndex::meta($this->db);
            $in_pass = ($meta['cursor'] ?? '') !== '' || ($meta['phase'] ?? '') === 'purge';
            if ($mode === 'auto' && !$in_pass && !$this->refresh_due($meta)) {
                return ['did' => 'idle'];
            }
            $done = $this->refresh($deadline, $mode === 'verify', $meta);
            return ['did' => 'refresh', 'done' => $done] + $this->stats;
        } finally {
            if ($this->db !== null && $this->db->inTransaction()) {
                $this->db->rollBack();
            }
            $this->db = null;
            $this->stmt = [];
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function refresh_interval(array $meta): int {
        $interval = max(10, (int) $this->index->option('refreshInterval', 300));
        // slow filesystems (network mounts): never spend more than a third of the time indexing
        return max($interval, (int) ceil(3 * (float) ($meta['pass_seconds'] ?? 0)));
    }

    private function refresh_due(array $meta): bool {
        return time() - (int) ($meta['pass_end'] ?? $meta['built_at'] ?? 0) >= $this->refresh_interval($meta);
    }

    private function rebuild_due(array $current): bool {
        try {
            $db = $this->index->open($current['gen'], false);
            $meta = SearchIndex::meta($db);
            return ($meta['rebuild_due'] ?? '0') === '1' || ($meta['state'] ?? '') !== 'ready';
        } catch (Throwable) {
            return true;
        }
    }

    // ---- shared ----------------------------------------------------------------------------

    private function writer_pragmas(bool $bulk): void {
        $this->db->exec('PRAGMA journal_mode = ' . ($bulk ? 'OFF' : 'WAL'));
        $this->db->exec('PRAGMA synchronous = ' . ($bulk ? 'OFF' : 'NORMAL'));
        $this->db->exec('PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY');
    }

    private function prepare(string $sql): PDOStatement {
        return $this->stmt[$sql] ??= $this->db->prepare($sql);
    }

    private function begin(): void {
        $this->db->beginTransaction();
        $this->last_commit = microtime(true);
    }

    private function maybe_commit(?callable $before = null): void {
        if (microtime(true) - $this->last_commit < SearchIndexer::COMMIT_SECONDS) {
            return;
        }
        if ($before !== null) {
            $before();
        }
        $this->db->commit();
        $this->db->beginTransaction();
        $this->last_commit = microtime(true);
        if ($this->progress !== null) {
            ($this->progress)();
        }
    }

    private function set_meta(array $values): void {
        $st = $this->prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
        foreach ($values as $k => $v) {
            $st->execute([$k, $v]);
        }
    }

    private function abs(string $rel): string {
        return $rel === '/' ? $this->root_path : $this->root_path . substr($rel, 0, -1);
    }

    private static function upper(string $path): string {
        return substr($path, 0, -1) . '0'; // "/a/" -> "/a0": every path below "/a/" sorts before it
    }

    private static function fid(array $st): string {
        return $st['dev'] . ':' . $st['ino'];
    }

    // ctime has one second resolution: a change in the same second as our stat would be missed
    // by the next comparison, so recently changed folders are stored dirty (ctime -1).
    private static function stored_ctime(array $st): int {
        return $st['ctime'] >= time() - 1 ? -1 : (int) $st['ctime'];
    }

    // The visible entries of a folder (no permissions), or whether it isn't managed.
    // $known: name => is_dir from the index, to skip a stat when only the ctime changed.
    private function list_dir(string $abs, string $rel, ?array $known = null): array {
        $handle = @opendir($abs);
        if ($handle === false) {
            return ['managed' => true, 'entries' => []];
        }
        $names = [];
        while (($name = readdir($handle)) !== false) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $names[] = $name;
            if (count($names) >= $this->max_entries) {
                if ($known === null) {
                    $this->log('more than ' . $this->max_entries . ' entries in ' . $rel . ', indexing the first ones');
                }
                break;
            }
        }
        closedir($handle);
        sort($names, SORT_STRING);

        $set = array_flip($names);
        foreach ($this->unmanaged as $name) {
            if (isset($set[$name])) {
                return ['managed' => false, 'entries' => []];
            }
        }
        if ($rel !== '/' && isset($set['_h6ai']) && @is_dir($abs . '/_h6ai/private/conf')) {
            return ['managed' => false, 'entries' => []]; // another h6ai install
        }

        $href = $this->context->to_href($abs);
        $entries = [];
        foreach ($names as $name) {
            $name = (string) $name;
            if ($this->context->is_hidden($name) || $this->context->is_hidden($href . $name)) {
                continue;
            }
            $child = $abs . '/' . $name;
            if ($child === $this->h6ai_path) {
                continue;
            }
            $entries[] = [$name, $known !== null && isset($known[$name]) ? $known[$name] : @is_dir($child)];
        }
        return ['managed' => true, 'entries' => $entries];
    }

    // Folders below the depth limit and symlinked folders are listed, not descended, except a
    // symlinked folder outside the tree (a disk linked into the share): that one is indexed,
    // once. Links into the tree, above it, or into or around another linked folder would only
    // repeat entries, or loop. $real: the target, when it is descended.
    private function folder_flags(int $id, string $abs, string $path, int $depth, ?string &$real = null): int {
        $real = null;
        $link = $path !== '/' && @is_link($abs);
        if ($depth >= $this->max_depth) {
            return SearchIndex::FLAG_DEEP | ($link ? SearchIndex::FLAG_LINK : 0);
        }
        if (!$link) {
            return 0;
        }
        $target = @realpath($abs);
        if ($target === false) {
            return SearchIndex::FLAG_LINK;
        }
        $target = rtrim($target, '/') . '/';
        $this->root_real ??= rtrim((string) (@realpath($this->root_path) ?: $this->root_path), '/') . '/';
        if (str_starts_with($target, $this->root_real) || str_starts_with($this->root_real, $target)) {
            return SearchIndex::FLAG_LINK;
        }
        foreach ($this->link_targets() as $other => $other_id) {
            if ($other_id !== $id && (str_starts_with($target, $other) || str_starts_with($other, $target))) {
                return SearchIndex::FLAG_LINK;
            }
        }
        $this->link_targets = array_filter($this->link_targets, fn ($other_id) => $other_id !== $id);
        $this->link_targets[$target] = $id;
        $real = $target;
        return SearchIndex::FLAG_LINKED;
    }

    private function link_targets(): array {
        if ($this->link_targets === null) {
            $this->link_targets = [];
            $st = $this->prepare('SELECT id, path FROM node WHERE (flags & ' . SearchIndex::FLAG_LINKED . ") != 0 AND path >= '/' AND path < '0'");
            $st->execute();
            foreach ($st->fetchAll() as $row) {
                $target = @realpath($this->abs((string) $row['path']));
                if ($target !== false) {
                    $this->link_targets[rtrim($target, '/') . '/'] = (int) $row['id'];
                }
            }
        }
        return $this->link_targets;
    }

    private function insert(int $parent, string $name, bool $is_dir, ?string $path, ?array $st, int $flags): int {
        $this->prepare('INSERT INTO node (parent, name, key, is_dir, path, mtime, ctime, fid, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([
                $parent, $name, SearchQuery::fold($name), $is_dir ? 1 : 0, $path,
                $st === null ? null : (int) $st['mtime'],
                $st === null ? null : SearchIndexer::stored_ctime($st),
                $st === null ? null : SearchIndexer::fid($st),
                $flags
            ]);
        $this->stats['changes'] += 1;
        return (int) $this->db->lastInsertId();
    }

    // ---- full build ------------------------------------------------------------------------

    private function create_indexes(bool $fill_fts): void {
        $this->db->exec('CREATE INDEX IF NOT EXISTS node_parent ON node(parent)');
        $this->db->exec('CREATE INDEX IF NOT EXISTS node_key ON node(key)');
        $this->db->exec('CREATE UNIQUE INDEX IF NOT EXISTS node_path ON node(path) WHERE path IS NOT NULL');
        $this->db->exec('CREATE INDEX IF NOT EXISTS node_fid ON node(fid) WHERE fid IS NOT NULL');
        $this->db->exec("CREATE VIRTUAL TABLE node_fts USING fts5(key, content='node', content_rowid='id', tokenize='trigram', detail=full)");
        if ($fill_fts) {
            try {
                // bigger in-memory batches before FTS5 writes a segment: several times faster bulk loads
                $this->db->exec("INSERT INTO node_fts(node_fts, rank) VALUES('hashsize', 67108864)");
            } catch (Throwable) {
                // older SQLite: default
            }
            $this->db->exec('INSERT INTO node_fts(rowid, key) SELECT id, key FROM node');
        }
        $this->db->exec("CREATE TRIGGER node_ai AFTER INSERT ON node BEGIN INSERT INTO node_fts(rowid, key) VALUES (new.id, new.key); END");
        $this->db->exec("CREATE TRIGGER node_ad AFTER DELETE ON node BEGIN INSERT INTO node_fts(node_fts, rowid, key) VALUES ('delete', old.id, old.key); END");
        $this->db->exec("CREATE TRIGGER node_au AFTER UPDATE OF key ON node BEGIN INSERT INTO node_fts(node_fts, rowid, key) VALUES ('delete', old.id, old.key); INSERT INTO node_fts(rowid, key) VALUES (new.id, new.key); END");
    }

    private function start_build(string $hard, string $soft, bool $bulk, string $reason): array {
        $gen = $this->index->next_gen();
        $this->index->remove_gen($gen);
        $building = ['gen' => $gen, 'hard' => $hard, 'soft' => $soft, 'at' => time(), 'bulk' => $bulk];
        $this->log('building generation ' . $gen . ' (' . $reason . ($bulk ? ', bulk' : ', in slices') . ')');

        // two generations plus slack must fit
        $current = $this->index->current();
        $size = $current ? (int) @filesize($this->index->file($current['gen'])) : 0;
        $free = @disk_free_space($this->index->dir());
        if ($free !== false && $size > 0 && $free < 1.5 * $size) {
            throw new RuntimeException('not enough disk space for a new index generation (' . round($size / 1048576) . ' MiB)');
        }

        $this->db = $this->index->open($gen, true);
        $this->link_targets = null;
        $this->writer_pragmas($bulk);
        $this->db->exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v)');
        // AUTOINCREMENT: ids are never reused, an id range only ever holds what it was built with
        $this->db->exec('CREATE TABLE node (id INTEGER PRIMARY KEY AUTOINCREMENT, parent INTEGER NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL,'
            . ' is_dir INTEGER NOT NULL, path TEXT, hi INTEGER, mtime INTEGER, ctime INTEGER, fid TEXT, flags INTEGER NOT NULL DEFAULT 0)');
        $this->db->exec('CREATE TABLE moved (id INTEGER PRIMARY KEY, hi INTEGER NOT NULL)');
        $this->db->exec('CREATE TABLE stack (seq INTEGER PRIMARY KEY, kind INTEGER NOT NULL, ref INTEGER NOT NULL, path TEXT, name TEXT, depth INTEGER)');
        if (!$bulk) {
            $this->create_indexes(false);
        }
        $this->begin();
        $this->set_meta(['schema' => SearchIndex::SCHEMA_VERSION, 'state' => 'building', 'started' => time(),
            'hard' => $hard, 'soft' => $soft, 'bulk' => $bulk ? '1' : '0']);
        $this->prepare('INSERT INTO stack (kind, ref, path, name, depth) VALUES (?, ?, ?, ?, ?)')
            ->execute([SearchIndexer::KIND_OPEN, 0, '/', '', 0]);
        $this->db->commit();
        $this->index->set_building($building);
        $this->db = null;
        $this->stmt = [];
        return $building;
    }

    private function build(array $building, float $deadline): bool {
        $bulk = !empty($building['bulk']);
        $this->db = $this->index->open($building['gen'], false);
        $this->link_targets = null;
        $this->writer_pragmas($bulk);
        $push = $this->prepare('INSERT INTO stack (kind, ref, path, name, depth) VALUES (?, ?, ?, ?, ?)');
        $top = $this->prepare('SELECT seq, kind, ref, path, name, depth FROM stack ORDER BY seq DESC LIMIT 1');
        $pop = $this->prepare('DELETE FROM stack WHERE seq = ?');
        $close = $this->prepare('UPDATE node SET hi = (SELECT max(id) FROM node) WHERE id = ?');
        $this->begin();
        while (true) {
            if (microtime(true) >= $deadline) {
                $this->db->commit();
                return false;
            }
            $top->execute();
            $frame = $top->fetch();
            $top->closeCursor();
            if ($frame === false) {
                break;
            }
            $pop->execute([$frame['seq']]);
            if ((int) $frame['kind'] === SearchIndexer::KIND_CLOSE) {
                $close->execute([$frame['ref']]);
            } else {
                $this->build_folder((int) $frame['ref'], (string) $frame['path'], (string) $frame['name'], (int) $frame['depth'], $push);
            }
            $this->maybe_commit();
        }
        $this->db->commit();
        $this->finish_build($building);
        return true;
    }

    private function build_folder(int $parent, string $path, string $name, int $depth, PDOStatement $push): void {
        $abs = $this->abs($path);
        $st = @stat($abs);
        if ($st === false || ($st['mode'] & 0170000) !== 0040000) {
            return; // gone meanwhile
        }
        $this->stats['folders'] += 1;
        $real = null;
        $flags = $this->folder_flags(0, $abs, $path, $depth, $real);
        $id = $this->insert($parent, $name, true, $path, $st, $flags);
        if ($path === '/' && $id !== SearchIndex::ROOT_ID) {
            throw new LogicException('root node must have id ' . SearchIndex::ROOT_ID);
        }
        if ($real !== null) {
            $this->link_targets[$real] = $id;
        }
        $listing = ($flags & SearchIndex::NOT_DESCENDED) === 0 ? $this->list_dir($abs, $path) : null;
        if ($listing === null || !$listing['managed']) {
            $this->prepare('UPDATE node SET hi = id, flags = ? WHERE id = ?')
                ->execute([$listing === null ? $flags : $flags | SearchIndex::FLAG_UNMANAGED, $id]);
            return;
        }
        $dirs = [];
        foreach ($listing['entries'] as [$child, $is_dir]) {
            if ($is_dir) {
                $dirs[] = $child;
            } else {
                $this->insert($id, $child, false, null, null, 0);
            }
        }
        $push->execute([SearchIndexer::KIND_CLOSE, $id, null, null, null]);
        foreach (array_reverse($dirs) as $child) {
            $push->execute([SearchIndexer::KIND_OPEN, $id, $path . $child . '/', $child, $depth + 1]);
        }
    }

    private function finish_build(array $building): void {
        $bulk = !empty($building['bulk']);
        if ($bulk) {
            $this->create_indexes(true);
        }
        $this->db->exec('DROP TABLE IF EXISTS stack');
        $counts = $this->db->query('SELECT count(*) AS entries, coalesce(sum(is_dir), 0) AS folders, coalesce(max(id), 0) AS base FROM node')->fetch();
        $this->db->exec('PRAGMA journal_mode = WAL');
        $meta = SearchIndex::meta($this->db);
        $this->db->beginTransaction();
        $this->set_meta([
            'state' => 'ready',
            'base_max' => (int) $counts['base'],
            'entries' => max(0, (int) $counts['entries'] - 1),
            'folders' => max(0, (int) $counts['folders'] - 1),
            'built_at' => time(),
            'build_seconds' => round(microtime(true) - (float) ($meta['started'] ?? time()), 1),
            'pass_end' => time(),
            'verify_at' => time(),
            'cursor' => '',
            'phase' => '',
            'rebuild_due' => '0'
        ]);
        $this->db->commit();
        $this->db->exec('PRAGMA optimize');
        $this->db->exec('PRAGMA wal_checkpoint(TRUNCATE)');
        $this->index->set_current(['gen' => $building['gen'], 'hard' => $building['hard'], 'soft' => $building['soft'], 'at' => time()]);
        $this->index->set_building(null);
        $this->index->touch_stamp('pass');
        $this->log(sprintf('generation %d ready: %d entries, %d folders', $building['gen'], $counts['entries'] - 1, $counts['folders'] - 1));
    }

    // ---- refresh pass ----------------------------------------------------------------------

    private function refresh(float $deadline, bool $verify, array $meta): bool {
        $this->begin();
        if (($meta['cursor'] ?? '') === '' && ($meta['phase'] ?? '') !== 'purge') {
            $verify_every = (int) $this->index->option('verifyInterval', 604800);
            $verify = $verify || $this->index->option('trustMtime', true) === false
                || ($verify_every > 0 && time() - (int) ($meta['verify_at'] ?? 0) >= $verify_every);
            $meta = ['cursor' => '', 'phase' => 'walk', 'pass_start' => microtime(true), 'pass_verify' => $verify ? '1' : '0',
                'pass_folders' => 0, 'pass_rescanned' => 0, 'pass_changes' => 0] + $meta;
            $this->set_meta(array_intersect_key($meta, array_flip(['cursor', 'phase', 'pass_start', 'pass_verify', 'pass_folders', 'pass_rescanned', 'pass_changes'])));
        }
        $verify = ($meta['pass_verify'] ?? '0') === '1';
        $cursor = (string) ($meta['cursor'] ?? '');
        $save = function () use (&$cursor, $meta) {
            $this->set_meta([
                'cursor' => $cursor,
                'pass_folders' => (int) $meta['pass_folders'] + $this->stats['folders'],
                'pass_rescanned' => (int) $meta['pass_rescanned'] + $this->stats['rescanned'],
                'pass_changes' => (int) $meta['pass_changes'] + $this->stats['changes']
            ]);
        };

        if (($meta['phase'] ?? '') !== 'purge') {
            $batch = $this->prepare('SELECT id, parent, name, path, mtime, ctime, fid, flags FROM node WHERE path > ? ORDER BY path LIMIT ' . SearchIndexer::BATCH);
            while (true) {
                $batch->execute([$cursor]);
                $rows = $batch->fetchAll();
                if (!$rows) {
                    break;
                }
                foreach ($rows as $row) {
                    if (microtime(true) >= $deadline) {
                        $save();
                        $this->db->commit();
                        return false;
                    }
                    $structural = $this->refresh_folder($row, $verify);
                    $cursor = (string) $row['path'];
                    $this->maybe_commit($save);
                    if ($structural) {
                        continue 2; // paths below may have changed: fetch again after the cursor
                    }
                }
            }
            $cursor = '';
            $save();
            $this->set_meta(['phase' => 'purge']);
        }

        // detached subtrees that didn't come back: delete them, in chunks
        while ($this->purge_chunk()) {
            if (microtime(true) >= $deadline) {
                $this->db->commit();
                return false;
            }
            $this->maybe_commit();
        }

        $meta = SearchIndex::meta($this->db);
        $base = (int) ($meta['base_max'] ?? 0);
        $max = (int) $this->db->query('SELECT coalesce(max(id), 0) FROM node')->fetchColumn();
        $moved = (int) $this->db->query('SELECT count(*) FROM moved')->fetchColumn();
        $due = $max - $base > max(SearchIndexer::REBUILD_DELTA_MIN, SearchIndexer::REBUILD_DELTA_RATIO * $base) || $moved > 1000;
        $entries = (int) $this->db->query('SELECT count(*) FROM node')->fetchColumn() - 1;
        $folders = (int) $this->db->query('SELECT count(*) FROM node WHERE path >= \'/\' AND path < \'0\'')->fetchColumn() - 1;
        $values = [
            'phase' => '',
            'cursor' => '',
            'pass_end' => time(),
            'pass_seconds' => round(microtime(true) - (float) ($meta['pass_start'] ?? microtime(true)), 2),
            'entries' => $entries,
            'folders' => $folders,
            'rebuild_due' => $due ? '1' : '0'
        ];
        if ($verify) {
            $values['verify_at'] = time();
        }
        $this->set_meta($values);
        $this->db->commit();
        $this->db->exec('PRAGMA wal_checkpoint(TRUNCATE)');
        $this->index->touch_stamp('pass');
        return true;
    }

    // Re-checks one folder. True if the tree changed (new, removed or moved folders).
    private function refresh_folder(array $row, bool $verify): bool {
        $this->stats['folders'] += 1;
        $id = (int) $row['id'];
        $path = (string) $row['path'];
        $abs = $this->abs($path);
        $st = @stat($abs);
        if ($id === SearchIndex::ROOT_ID) {
            if ($st === false) {
                return false; // never wipe the index because the root is (temporarily) missing
            }
        } elseif ($st === false || ($st['mode'] & 0170000) !== 0040000) {
            // gone (or a symlink whose target is), and its folder's listing didn't show it yet:
            // that folder is re-listed by the next pass (it may be a file now)
            $this->detach($id, $path);
            $this->prepare('UPDATE node SET ctime = -1 WHERE id = ?')->execute([(int) $row['parent']]);
            return true;
        }
        // deleted and created again under the same name: same node, everything re-checked
        $verify = $verify || ($row['fid'] !== null && $row['fid'] !== SearchIndexer::fid($st));

        $flags = $this->folder_flags($id, $abs, $path, substr_count($path, '/') - 1);
        $old_flags = (int) $row['flags'];
        // a dirty folder (changed in the second of its last listing) may have changed again
        // in that second, mtime unchanged: fully re-listed
        $mtime_changed = $row['mtime'] === null || (int) $row['mtime'] !== (int) $st['mtime'] || (int) $row['ctime'] === -1;
        $changed = $verify || $mtime_changed || (int) $row['ctime'] !== (int) $st['ctime']
            || ($old_flags & (SearchIndex::FLAG_LINK | SearchIndex::FLAG_LINKED | SearchIndex::FLAG_DEEP)) !== $flags;
        if (!$changed) {
            return false;
        }
        $this->stats['rescanned'] += 1;
        $update = $this->prepare('UPDATE node SET mtime = ?, ctime = ?, fid = ?, flags = ? WHERE id = ?');

        $children = [];
        $st_children = $this->prepare('SELECT id, name, is_dir, path FROM node WHERE parent = ?');
        $st_children->execute([$id]);
        foreach ($st_children->fetchAll() as $child) {
            $children[(string) $child['name']] = $child;
        }

        $listing = ($flags & SearchIndex::NOT_DESCENDED) === 0
            ? $this->list_dir($abs, $path, $mtime_changed || $verify ? null : array_map(fn ($c) => (bool) $c['is_dir'], $children)) : null;
        if ($listing === null || !$listing['managed']) {
            // not descended (any more): drop what was below
            $structural = false;
            foreach ($children as $child) {
                $this->remove_child($child);
                $structural = true;
            }
            $update->execute([(int) $st['mtime'], SearchIndexer::stored_ctime($st), SearchIndexer::fid($st), $listing === null ? $flags : $flags | SearchIndex::FLAG_UNMANAGED, $id]);
            return $structural;
        }

        $structural = false;
        $kept = []; // id => name of the folders that stay
        foreach ($listing['entries'] as [$name, $is_dir]) {
            $child = $children[$name] ?? null;
            unset($children[$name]);
            if ($child !== null && (bool) $child['is_dir'] === $is_dir) {
                if ($is_dir) {
                    $kept[(int) $child['id']] = $name;
                }
                continue;
            }
            if ($child !== null) {
                $this->remove_child($child);
            }
            $structural = true;
            if ($is_dir) {
                $child_path = $path . $name . '/';
                $child_st = @stat($abs . '/' . $name);
                $moved = $child_st === false ? null : $this->reattach(SearchIndexer::fid($child_st), $id, $name, $child_path);
                if ($moved !== null) {
                    // renamed in this folder: its old name is the same node, not a removal
                    $children = array_filter($children, fn ($c) => (int) $c['id'] !== $moved);
                    if (isset($kept[$moved])) {
                        // renamed, and a new folder took the old name (mv logs logs.1; mkdir logs)
                        $this->insert($id, $kept[$moved], true, $path . $kept[$moved] . '/', null, 0);
                        unset($kept[$moved]);
                    }
                    continue;
                }
                // mtime null: the pass visits it (its path sorts after the cursor)
                $this->insert($id, $name, true, $child_path, null, 0);
            } else {
                $this->insert($id, $name, false, null, null, 0);
            }
        }
        foreach ($children as $child) {
            $this->remove_child($child);
            $structural = true;
        }
        $update->execute([(int) $st['mtime'], SearchIndexer::stored_ctime($st), SearchIndexer::fid($st), $flags, $id]);
        return $structural;
    }

    private function remove_child(array $child): void {
        $this->stats['changes'] += 1;
        if ((int) $child['is_dir'] === 1 && $child['path'] !== null) {
            $this->detach((int) $child['id'], (string) $child['path']);
        } else {
            $this->prepare('DELETE FROM node WHERE id = ?')->execute([(int) $child['id']]);
        }
    }

    // Moves a folder's subtree out of every search scope ("#<id>/..."), keeping it for a while
    // in case it was moved, not deleted.
    private function detach(int $id, string $path): void {
        if ($this->link_targets !== null) {
            $this->link_targets = array_filter($this->link_targets, fn ($other) => $other !== $id);
        }
        $this->rewrite_paths($path, '#' . $id . '/');
        $this->prepare('UPDATE node SET parent = -1 WHERE id = ?')->execute([$id]);
    }

    private function rewrite_paths(string $from, string $to): void {
        $this->prepare('UPDATE node SET path = ? || CAST(substr(CAST(path AS BLOB), ?) AS TEXT) WHERE path >= ? AND path < ?')
            ->execute([$to, strlen($from) + 1, $from, SearchIndexer::upper($from)]);
    }

    // A folder with this device+inode that is detached, or whose indexed path no longer is it:
    // the same folder, renamed or moved. It keeps its subtree and ids. Returns its id.
    private function reattach(string $fid, int $parent, string $name, string $path): ?int {
        // symlinked folders share the fid of their target, but are not descended: never them
        $st = $this->prepare('SELECT id, path, hi FROM node WHERE fid = ? AND is_dir = 1 AND (flags & ' . SearchIndex::FLAG_LINK . ') = 0');
        $st->execute([$fid]);
        foreach ($st->fetchAll() as $row) {
            $old = (string) $row['path'];
            if ($old === $path) {
                continue;
            }
            if (!str_starts_with($old, '#')) {
                $old_st = @stat($this->abs($old));
                if ($old_st !== false && SearchIndexer::fid($old_st) === $fid) {
                    continue; // still there: a second link (bind mount) to the same folder
                }
            }
            if (str_starts_with($path, $old)) {
                continue; // moved into its own subtree: can't be
            }
            try {
                $this->rewrite_paths($old, $path);
                $this->prepare('UPDATE node SET parent = ?, name = ?, key = ? WHERE id = ?')
                    ->execute([$parent, $name, SearchQuery::fold($name), (int) $row['id']]);
                $this->prepare('INSERT OR REPLACE INTO moved (id, hi) VALUES (?, ?)')
                    ->execute([(int) $row['id'], (int) ($row['hi'] ?? $row['id'])]);
            } catch (PDOException $err) {
                $this->log('cannot move ' . $old . ' to ' . $path . ': ' . $err->getMessage());
                return null;
            }
            $this->stats['changes'] += 1;
            return (int) $row['id'];
        }
        return null;
    }

    // Deletes up to CHUNK rows of detached subtrees. False when nothing is left.
    private function purge_chunk(): bool {
        $files = $this->prepare('DELETE FROM node WHERE id IN (SELECT n.id FROM node d JOIN node n ON n.parent = d.id'
            . " WHERE d.path >= '#' AND d.path < '$' AND n.is_dir = 0 LIMIT " . SearchIndexer::CHUNK . ')');
        $files->execute();
        if ($files->rowCount() > 0) {
            return true;
        }
        $dirs = $this->prepare("DELETE FROM node WHERE id IN (SELECT id FROM node WHERE path >= '#' AND path < '$' LIMIT " . SearchIndexer::CHUNK . ')');
        $dirs->execute();
        return $dirs->rowCount() > 0;
    }

    // ---- request tail ----------------------------------------------------------------------

    // Installs without the CLI indexer (drop-in, shared hosting): after a response has been sent,
    // one PHP-FPM worker does a few seconds of index work if some is due. Never more than one at
    // a time (writer lock), at most one attempt every 15 s, and not while the CLI indexer runs.
    public static function tick(Context $context): void {
        try {
            if ($context->query_option('search.enabled', false) !== true || !function_exists('fastcgi_finish_request')
                || !$context->get_setup()->get('HAS_WRITABLE_CACHE_PRV')) {
                return;
            }
            $index = new SearchIndex($context);
            $background = $index->option('background', 'auto');
            if ($index->option('enabled', true) === false || !in_array($background, ['auto', 'requests'], true)) {
                return;
            }
            $tick = $index->stamp_age('tick');
            if ($tick !== null && $tick < 15) {
                return;
            }
            $interval = max(10, (int) $index->option('refreshInterval', 300));
            $daemon = $index->stamp_age('daemon');
            if ($background === 'auto' && $daemon !== null && $daemon < 3 * $interval + 120) {
                return;
            }
            // from here on at most once per 15 s, whether or not there is work
            $index->touch_stamp('tick');
            $pass = $index->stamp_age('pass');
            $current = $pass !== null && $pass < $interval ? $index->current() : null;
            if ($current !== null && $current['hard'] === $index->hard_fingerprint() && $current['soft'] === $index->soft_fingerprint()
                && !$index->building() && !is_file($index->dir() . '/rebuild.request')) {
                return; // nothing due
            }
            if (!SearchIndex::support()['ok']) {
                return;
            }
            $index->record_site();
            fastcgi_finish_request();
            ignore_user_abort(true);
            $slice = max(0.5, min(30.0, (float) $index->option('sliceTime', 2)));
            @set_time_limit((int) ceil($slice * 10) + 60);
            (new SearchIndexer($context, $index, fn ($msg) => Logger::log('search index: ' . $msg)))->run($slice);
        } catch (Throwable $err) {
            Logger::log('search index: ' . $err->getMessage());
        }
    }
}

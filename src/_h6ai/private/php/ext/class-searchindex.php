<?php
declare(strict_types=1);

// Storage of the search index: where it lives, which generation is current, whether it fits
// this installation, connections. Built and refreshed by SearchIndexer, queried by SearchEngine.
// See docs/SEARCH.md.
//
// private/cache/search-<h>/          <h> from the installation secret: on drop-in installs
//     index.php                      private/cache is inside the web root, and the index holds
//     current.json                   every name, also those in restricted folders
//     building.json
//     index-<gen>.sqlite (+ -wal, -shm)
//     writer.lock
// private/cache/search-*.stamp       cheap "is work due" checks without the secret
// private/cache/search-site.json.php what PHP-FPM sees (paths), for the CLI indexer
final class SearchIndex {
    public const SCHEMA_VERSION = 1;
    public const FLAG_UNMANAGED = 1;   // folder listed, not descended: view.unmanaged / nested install
    public const FLAG_LINK = 2;        // symlinked folder into the tree (or a second link): listed, not descended
    public const FLAG_DEEP = 4;        // below the depth limit: listed, not descended
    public const FLAG_LINKED = 16;     // symlinked folder outside the tree (another disk linked in): descended
    public const NOT_DESCENDED = self::FLAG_UNMANAGED | self::FLAG_LINK | self::FLAG_DEEP;
    public const ROOT_ID = 1;

    private const MIN_SQLITE = '3.34.0'; // trigram tokenizer
    private const GRACE = 120;           // seconds an old generation stays for readers that opened it

    private static ?array $support = null;
    private ?string $dir = null;

    public function __construct(private readonly Context $context) {}

    public static function support(): array {
        if (SearchIndex::$support !== null) {
            return SearchIndex::$support;
        }
        $status = ['ok' => false, 'sqlite' => null, 'reason' => ''];
        if (!extension_loaded('pdo_sqlite')) {
            $status['reason'] = 'the PHP extension pdo_sqlite is missing';
            return SearchIndex::$support = $status;
        }
        try {
            $db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $status['sqlite'] = (string) $db->query('SELECT sqlite_version()')->fetchColumn();
            if (version_compare($status['sqlite'], SearchIndex::MIN_SQLITE, '<')) {
                $status['reason'] = 'SQLite ' . $status['sqlite'] . ' is too old (needs ' . SearchIndex::MIN_SQLITE . ' for trigram search)';
                return SearchIndex::$support = $status;
            }
            $db->exec("CREATE VIRTUAL TABLE t USING fts5(k, tokenize='trigram')");
            $status['ok'] = true;
        } catch (Throwable $err) {
            $status['reason'] = 'SQLite has no FTS5 trigram support: ' . $err->getMessage();
        }
        return SearchIndex::$support = $status;
    }

    public function option(string $key, mixed $default): mixed {
        return $this->context->query_option('search.index.' . $key, $default);
    }

    public function is_enabled(): bool {
        return $this->context->query_option('search.enabled', false) === true && $this->option('enabled', true) !== false;
    }

    public function cache_path(): string {
        return (string) $this->context->get_setup()->get('CACHE_PRV_PATH');
    }

    public function dir(): string {
        if ($this->dir === null) {
            $this->dir = $this->cache_path() . '/search-' . substr(hash_hmac('sha256', 'h6ai search index', $this->context->get_secret()), 0, 20);
        }
        return $this->dir;
    }

    public function ensure_dir(): bool {
        $dir = $this->dir();
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            return false;
        }
        // drop-in installs: keeps nginx from listing the folder (see private/cache/index.php)
        if (!is_file($dir . '/index.php')) {
            @file_put_contents($dir . '/index.php', Json::GUARD);
        }
        return is_writable($dir);
    }

    // The indexer starts a new generation at its next run (admin page: "Rebuild").
    public function request_rebuild(): bool {
        return $this->ensure_dir() && @touch($this->dir() . '/rebuild.request');
    }

    public function stamp(string $name): string {
        return $this->cache_path() . '/search-' . $name . '.stamp';
    }

    public function touch_stamp(string $name): void {
        @touch($this->stamp($name));
        clearstatcache(true, $this->stamp($name));
    }

    public function stamp_age(string $name): ?int {
        clearstatcache(true, $this->stamp($name));
        $mtime = @filemtime($this->stamp($name));
        return $mtime === false ? null : max(0, time() - $mtime);
    }

    // ---- fingerprints ---------------------------------------------------------------------

    // What the index can't be used without: the same tree, hrefs and folding.
    public function hard_fingerprint(): string {
        $setup = $this->context->get_setup();
        return substr(sha1(json_encode([
            SearchIndex::SCHEMA_VERSION,
            SearchQuery::fold_signature(),
            $setup->get('ROOT_PATH'),
            $setup->get('ROOT_HREF'),
            $setup->get('H6AI_PATH')
        ])), 0, 16);
    }

    // What decides which names are indexed. A mismatch means: still usable (every result is
    // checked again), but rebuild.
    public function soft_fingerprint(): string {
        return substr(sha1(json_encode([
            $this->context->query_option('view.hidden', []),
            $this->context->query_option('view.unmanaged', []),
            $this->max_entries(),
            $this->max_depth()
        ])), 0, 16);
    }

    public function max_entries(): int {
        return max(100, (int) $this->option('maxEntriesPerFolder', 100000));
    }

    public function max_depth(): int {
        return max(1, min(256, (int) $this->option('maxDepth', 64)));
    }

    // ---- the site as PHP-FPM sees it -------------------------------------------------------

    public function site_file(): string {
        return $this->cache_path() . '/search-site.json.php';
    }

    // Called on web requests: records what the CLI needs to see the same paths and hrefs.
    public function record_site(): void {
        $setup = $this->context->get_setup();
        $site = [
            'scriptName' => $setup->get('SCRIPT_NAME'),
            'serverConf' => $setup->get('HAS_SERVER_CONF'),
            'filesFolder' => $setup->get('FILES_FOLDER'),
            'documentRoot' => $setup->get('DOCUMENT_ROOT'),
            'rootPath' => $setup->get('ROOT_PATH'),
            'rootHref' => $setup->get('ROOT_HREF')
        ];
        $json = json_encode($site, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $raw = @file_get_contents($this->site_file());
        if (is_string($raw) && Json::unguard($raw) === $json) {
            return;
        }
        Json::write_guarded($this->site_file(), (string) $json);
    }

    public static function read_site(string $cache_path): ?array {
        $raw = @file_get_contents($cache_path . '/search-site.json.php');
        $site = is_string($raw) ? json_decode(Json::unguard($raw), true) : null;
        return is_array($site) ? $site : null;
    }

    // ---- generations -----------------------------------------------------------------------

    public function file(int $gen): string {
        return $this->dir() . '/index-' . $gen . '.sqlite';
    }

    private function read_json(string $name): ?array {
        $raw = @file_get_contents($this->dir() . '/' . $name);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($data) && is_int($data['gen'] ?? null) ? $data : null;
    }

    private function write_json(string $name, ?array $data): void {
        $file = $this->dir() . '/' . $name;
        if ($data === null) {
            @unlink($file);
            return;
        }
        $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (@file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES)) === false || !@rename($tmp, $file)) {
            @unlink($tmp);
            throw new RuntimeException('cannot write ' . $file);
        }
    }

    // {gen, hard, soft, at} of the generation readers use, or null.
    public function current(): ?array {
        return $this->read_json('current.json');
    }

    public function set_current(?array $data): void {
        $this->write_json('current.json', $data);
    }

    // {gen, hard, soft, at, bulk} of a generation being built, or null.
    public function building(): ?array {
        return $this->read_json('building.json');
    }

    public function set_building(?array $data): void {
        $this->write_json('building.json', $data);
    }

    public function next_gen(): int {
        $max = 0;
        foreach (glob($this->dir() . '/index-*.sqlite') ?: [] as $file) {
            if (preg_match('/index-(\d+)\.sqlite$/', $file, $m)) {
                $max = max($max, (int) $m[1]);
            }
        }
        foreach ([$this->current(), $this->building()] as $info) {
            $max = max($max, (int) ($info['gen'] ?? 0));
        }
        return $max + 1;
    }

    public function remove_gen(int $gen): void {
        foreach (['', '-wal', '-shm', '-journal'] as $suffix) {
            @unlink($this->file($gen) . $suffix);
        }
    }

    // Deletes generations that are neither current nor being built, after the grace period.
    public function cleanup(): void {
        $keep = array_filter([$this->current()['gen'] ?? null, $this->building()['gen'] ?? null]);
        foreach (glob($this->dir() . '/index-*.sqlite') ?: [] as $file) {
            if (preg_match('/index-(\d+)\.sqlite$/', $file, $m) && !in_array((int) $m[1], $keep, true)
                && (int) @filemtime($file) < time() - SearchIndex::GRACE) {
                $this->remove_gen((int) $m[1]);
            }
        }
    }

    // ---- connections -----------------------------------------------------------------------

    // PHP 8.4 moved the SQLite specifics to Pdo\Sqlite; the PDO::SQLITE_* names are deprecated later.
    private static function sqlite_const(string $name, string $legacy): int {
        return defined('Pdo\\Sqlite::' . $name) ? constant('Pdo\\Sqlite::' . $name) : constant('PDO::' . $legacy);
    }

    public function open(int $gen, bool $create): PDO {
        $flags = SearchIndex::sqlite_const('OPEN_READWRITE', 'SQLITE_OPEN_READWRITE')
            | ($create ? SearchIndex::sqlite_const('OPEN_CREATE', 'SQLITE_OPEN_CREATE') : 0);
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 5,
            SearchIndex::sqlite_const('ATTR_OPEN_FLAGS', 'SQLITE_ATTR_OPEN_FLAGS') => $flags
        ];
        $dsn = 'sqlite:' . $this->file($gen);
        $db = method_exists(PDO::class, 'connect') ? PDO::connect($dsn, null, null, $options) : new PDO($dsn, null, null, $options);
        $db->exec('PRAGMA busy_timeout = 5000');
        return $db;
    }

    // A PHP function callable from SQL (Pdo\Sqlite::createFunction on PHP 8.4+).
    public static function create_function(PDO $db, string $name, callable $fn, int $args): void {
        if (method_exists($db, 'createFunction')) {
            $db->createFunction($name, $fn, $args);
        } else {
            $db->sqliteCreateFunction($name, $fn, $args);
        }
    }

    // The current generation for searching, or null with the reason. Never creates a file: a
    // reader racing the deletion of an old generation must not leave an empty database behind.
    public function open_reader(?string &$reason = null): ?array {
        $support = SearchIndex::support();
        if (!$support['ok']) {
            $reason = $support['reason'];
            return null;
        }
        $current = $this->current();
        if ($current === null) {
            $reason = $this->building() ? 'the index is being built' : 'no index yet';
            return null;
        }
        if (($current['hard'] ?? '') !== $this->hard_fingerprint()) {
            $reason = 'the index was built for a different setup, it is rebuilt';
            return null;
        }
        if (!is_file($this->file($current['gen']))) {
            $reason = 'the index file is missing';
            return null;
        }
        try {
            $db = $this->open($current['gen'], false);
            $db->exec('PRAGMA query_only = 1; PRAGMA cache_size = -4000; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 268435456');
            $meta = [];
            foreach ($db->query('SELECT k, v FROM meta') as $row) {
                $meta[$row['k']] = $row['v'];
            }
            if (($meta['state'] ?? '') !== 'ready') {
                $reason = 'the index is not ready';
                return null;
            }
            return ['db' => $db, 'meta' => $meta, 'current' => $current, 'stale' => ($current['soft'] ?? '') !== $this->soft_fingerprint()];
        } catch (Throwable $err) {
            $reason = 'cannot open the index: ' . $err->getMessage();
            return null;
        }
    }

    public static function meta(PDO $db): array {
        $meta = [];
        foreach ($db->query('SELECT k, v FROM meta') as $row) {
            $meta[$row['k']] = $row['v'];
        }
        return $meta;
    }

    // For the admin page and the CLI.
    public function status(): array {
        $support = SearchIndex::support();
        $status = [
            'enabled' => $this->is_enabled(),
            'supported' => $support['ok'],
            'sqlite' => $support['sqlite'],
            'reason' => $support['reason'],
            'usable' => false,
            'stale' => false,
            'building' => null,
            'daemon' => null,
            'lastPass' => null
        ];
        $daemon_age = $this->stamp_age('daemon');
        $status['daemon'] = $daemon_age !== null && $daemon_age < 3 * (int) $this->option('refreshInterval', 300) + 120;
        if (!$support['ok']) {
            return $status;
        }
        $building = $this->building();
        if ($building) {
            $status['building'] = ['gen' => $building['gen'], 'since' => $building['at'] ?? null];
            try {
                $db = $this->open($building['gen'], false);
                $status['building']['entries'] = (int) $db->query('SELECT max(id) FROM node')->fetchColumn();
            } catch (Throwable) {
                // not created yet
            }
        }
        $reason = '';
        $reader = $this->open_reader($reason);
        $status['reason'] = $reason;
        if ($reader === null) {
            return $status;
        }
        $meta = $reader['meta'];
        $file = $this->file($reader['current']['gen']);
        $status['usable'] = true;
        $status['stale'] = $reader['stale'];
        $status['gen'] = $reader['current']['gen'];
        $status['entries'] = (int) ($meta['entries'] ?? 0);
        $status['folders'] = (int) ($meta['folders'] ?? 0);
        $status['bytes'] = (int) @filesize($file) + (int) @filesize($file . '-wal');
        $status['built'] = isset($meta['built_at']) ? (int) $meta['built_at'] : null;
        $status['buildSeconds'] = isset($meta['build_seconds']) ? (float) $meta['build_seconds'] : null;
        $status['delta'] = (int) $reader['db']->query('SELECT coalesce(max(id), 0) FROM node')->fetchColumn() - (int) ($meta['base_max'] ?? 0);
        if (isset($meta['pass_end'])) {
            $status['lastPass'] = [
                'at' => (int) $meta['pass_end'],
                'seconds' => (float) ($meta['pass_seconds'] ?? 0),
                'folders' => (int) ($meta['pass_folders'] ?? 0),
                'rescanned' => (int) ($meta['pass_rescanned'] ?? 0),
                'changes' => (int) ($meta['pass_changes'] ?? 0)
            ];
        }
        $status['pass'] = isset($meta['cursor']) && $meta['cursor'] !== '' ? ['cursor' => true] : null;
        return $status;
    }
}

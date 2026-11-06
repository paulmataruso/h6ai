<?php
declare(strict_types=1);

// Runs a parsed query against the search index (see SearchIndex, docs/SEARCH.md).
//
// Every statement has a LIMIT, and the work is split into id windows with a deadline check in
// between (SQLite queries can't be interrupted from PHP). Scope and permissions turn into id
// ranges first (a folder's subtree is (id, hi] from the depth first build, plus entries added
// or moved since, which are checked by path), so a search in a small folder, or by a user who
// sees only a few folders, never wades through the rest of the tree.
//
//   first word                    exact names and names starting with it, through the key
//                                 index: if they fill the page, nothing else can rank higher
//   fragments of >= 3 characters  FTS5 trigram phrases, at most `candidates` per query
//   otherwise (1-2 letters, *.c)  a windowed scan of at most SCAN_BUDGET entries
//   re:                           windowed scan with a PHP REGEXP function, deadline enforced inside
//
// Joins are CROSS JOINs: SQLite keeps that order. Left to itself the planner may start from the
// scope condition on the parent folder (node_path) and walk the whole tree for a handful of
// candidates.
final class SearchEngine {
    private const FTS_WINDOW = 2000000;
    private const SCAN_WINDOW = 100000;
    private const SCAN_BUDGET = 300000;
    private const PREFIX_CANDIDATES = 5000;
    private const EXACT_CANDIDATES = 1000;

    private array $binds = [];
    private bool $timed_out = false;

    public function __construct(private readonly PDO $db, private readonly array $meta) {}

    // $plan: Acl::search_plan() (null: no restriction). Returns:
    //   found      false if the scope folder isn't in the index (the caller falls back)
    //   rows       [{id, name, is_dir, flags, path, ppath, r, kl, pl, key}] best first, <= $fetch
    //   truncated  the candidate cut-off or the deadline was hit: there may be better matches
    public function search(string $scope, SearchQuery $query, ?array $plan, int $fetch, int $candidates, float $deadline, bool $ignorecase): array {
        $node = $this->node($scope);
        if ($node === null || ($scope !== '/' && ((int) $node['flags'] & SearchIndex::NOT_DESCENDED))) {
            return ['found' => false, 'rows' => [], 'truncated' => false];
        }
        $ranges = $this->ranges($scope, $node, $plan);
        $rows = [];
        $truncated = false;

        if ($query->regex !== null) {
            $this->register_regex($query->regex_pattern($ignorecase), $deadline);
        }

        $fragments = $query->regex === null ? $query->fragments() : [];
        $tiered = false;
        if ($query->regex === null && $query->rank_term() !== '') {
            [$rows, $cut] = $this->prefix_tier($query, $scope, $plan, $ranges, $fetch);
            // a full page of exact and prefix matches: nothing else ranks higher
            $tiered = count($rows) >= $fetch;
            $truncated = $tiered && $cut;
        }
        if ($tiered) {
            // done
        } elseif ($fragments) {
            $left = $candidates;
            foreach ($this->windows($ranges, SearchEngine::FTS_WINDOW) as [$lo, $hi]) {
                if (microtime(true) >= $deadline) {
                    $truncated = true;
                    break;
                }
                [$count, $found] = $this->fts_window($query, $scope, $plan, $lo, $hi, $left, $fetch);
                $rows = $this->merge($rows, $found, $fetch);
                $left -= $count;
                if ($left <= 0) {
                    $truncated = true;
                    break;
                }
            }
        } else {
            // every window's best, merged: exact within the budget (short words can't use the
            // trigram index, so a big tree is only partly scanned)
            $budget = $query->regex === null ? SearchEngine::SCAN_BUDGET : PHP_INT_MAX;
            foreach ($this->windows($ranges, SearchEngine::SCAN_WINDOW) as [$lo, $hi]) {
                if (microtime(true) >= $deadline || $budget <= 0) {
                    $truncated = true;
                    break;
                }
                $budget -= $hi - $lo + 1;
                $rows = $this->merge($rows, $this->scan_window($query, $scope, $plan, $lo, $hi, $fetch), $fetch);
                if ($this->timed_out) {
                    $truncated = true;
                    break;
                }
            }
        }
        if (($plan['roots'] ?? null) !== null && $plan['reachable']) {
            $rows = $this->add_reachable($rows, $plan['reachable'], $scope, $query, $ignorecase, $fetch);
        }
        return ['found' => true, 'rows' => array_values($rows), 'truncated' => $truncated];
    }

    // Users who can't list the root are searched in their listable subtrees only. The folders
    // above those, shown so they can navigate down, are matched here (few, from the rules).
    private function add_reachable(array $rows, array $reachable, string $scope, SearchQuery $query, bool $ignorecase, int $fetch): array {
        $term = $query->rank_term();
        $known = array_column($rows, null, 'path');
        foreach ($reachable as $path) {
            if ($path === $scope || !str_starts_with($path, $scope) || isset($known[$path])) {
                continue;
            }
            $name = basename(rtrim($path, '/'));
            $node = $this->node($path);
            if ($node === null || !$query->matches_name($name, $ignorecase)) {
                continue;
            }
            $key = SearchQuery::fold($name);
            $ppath = substr($path, 0, -strlen($name) - 1);
            $rows[] = ['id' => (int) $node['id'], 'name' => $name, 'is_dir' => 1, 'flags' => (int) $node['flags'], 'path' => $path,
                'ppath' => $ppath, 'r' => SearchEngine::rank_php($key, $term), 'kl' => mb_strlen($key), 'pl' => mb_strlen($ppath), 'key' => $key];
        }
        usort($rows, [SearchEngine::class, 'cmp']);
        return array_slice($rows, 0, $fetch);
    }

    public function node(string $path): ?array {
        $st = $this->db->prepare('SELECT id, hi, flags, path FROM node WHERE path = ?');
        $st->execute([$path]);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    // Id ranges to look in, entries added since the build first (newest uploads aren't the ones
    // cut off). Everything found is still checked against the scope by path.
    private function ranges(string $scope, array $node, ?array $plan): array {
        $base = (int) ($this->meta['base_max'] ?? 0);
        $extra = [[$base + 1, PHP_INT_MAX]];
        foreach ($this->db->query('SELECT id, hi FROM moved') as $moved) {
            $extra[] = [(int) $moved['id'], (int) $moved['hi']];
        }
        $subtree = fn (array $n, bool $self) => $n['hi'] === null ? [] : [[(int) $n['id'] + ($self ? 0 : 1), (int) $n['hi']]];

        $main = $scope === '/' ? [[SearchIndex::ROOT_ID + 1, $base]] : $subtree($node, false);
        $roots = $plan['roots'] ?? null;
        if ($roots !== null) {
            $inside = false;
            foreach ($roots as $root) {
                $inside = $inside || str_starts_with($scope, $root);
            }
            if (!$inside) {
                // only the listable folders below the scope can hold visible entries
                $main = [];
                foreach ($roots as $root) {
                    $root_node = str_starts_with($root, $scope) ? $this->node($root) : null;
                    if ($root_node === null) {
                        continue;
                    }
                    // the folder itself, and its subtree if it has one in the index
                    $main = array_merge($main, (int) $root_node['flags'] & SearchIndex::NOT_DESCENDED
                        ? [[(int) $root_node['id'], (int) $root_node['id']]] : $subtree($root_node, true));
                }
            }
        }
        return array_merge($extra, $main);
    }

    private function windows(array $ranges, int $size): Generator {
        $max = (int) $this->db->query('SELECT coalesce(max(id), 0) FROM node')->fetchColumn();
        foreach ($ranges as [$lo, $hi]) {
            $hi = min($hi, $max);
            for ($start = $lo; $start <= $hi; $start += $size) {
                yield [$start, $hi - $start >= $size ? $start + $size - 1 : $hi];
            }
        }
    }

    public static function cmp(array $a, array $b): int {
        return [(int) $a['r'], -(int) $a['is_dir'], (int) $a['kl'], (int) $a['pl'], $a['key'], (int) $a['id']]
            <=> [(int) $b['r'], -(int) $b['is_dir'], (int) $b['kl'], (int) $b['pl'], $b['key'], (int) $b['id']];
    }

    private function merge(array $rows, array $more, int $fetch): array {
        foreach ($more as $row) {
            $rows[$row['id']] = $row;
        }
        uasort($rows, [SearchEngine::class, 'cmp']);
        return array_slice($rows, 0, $fetch, true);
    }

    // ---- SQL building ----------------------------------------------------------------------

    private function bind(mixed $value): string {
        $name = ':b' . count($this->binds);
        $this->binds[$name] = $value;
        return $name;
    }

    private function run(string $sql): PDOStatement {
        // names start over per statement: one built for an earlier statement would be NULL here
        preg_match_all('/:b\d+/', $sql, $used);
        if (array_diff($used[0], array_keys($this->binds))) {
            $this->binds = [];
            throw new LogicException('search: unbound SQL parameter');
        }
        $st = $this->db->prepare($sql);
        foreach ($this->binds as $name => $value) {
            $st->bindValue($name, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $this->binds = [];
        $st->execute();
        return $st;
    }

    private static function upper(string $path): string {
        return substr($path, 0, -1) . '0';
    }

    private const COLUMNS = 'n.id, n.name, n.is_dir, n.flags, n.path, p.path AS ppath, length(n.key) AS kl, length(p.path) AS pl, n.key';
    private const ORDER = 'r, n.is_dir DESC, kl, pl, n.key, n.id';

    private function rank(SearchQuery $query): string {
        $t = $query->rank_term();
        if ($t === '') {
            return '3 AS r';
        }
        $q = $this->bind($t);
        $q_hi = $this->bind($t . "\xFF");
        $dot = $this->bind($t . '.');
        $dot_hi = $this->bind($t . ".\xFF");
        $len = $this->bind(mb_strlen($t) + 2);
        $boundary = [];
        foreach ([' ', '_', '-', '.', '(', '[', '+'] as $sep) {
            $boundary[] = 'instr(n.key, ' . $this->bind($sep . $t) . ') > 0';
        }
        return "CASE WHEN n.key = $q THEN 0"
            . " WHEN n.key >= $dot AND n.key < $dot_hi AND instr(substr(n.key, $len), '.') = 0 THEN 0"
            . " WHEN n.key >= $q AND n.key < $q_hi THEN 1"
            . ' WHEN ' . implode(' OR ', $boundary) . ' THEN 2 ELSE 3 END AS r';
    }

    // Same ranking in PHP, for the few folders added outside SQL.
    public static function rank_php(string $key, string $t): int {
        if ($t === '') {
            return 3;
        }
        if ($key === $t || (str_starts_with($key, $t . '.') && !str_contains(substr($key, strlen($t) + 1), '.'))) {
            return 0;
        }
        if (str_starts_with($key, $t)) {
            return 1;
        }
        foreach ([' ', '_', '-', '.', '(', '[', '+'] as $sep) {
            if (str_contains($key, $sep . $t)) {
                return 2;
            }
        }
        return 3;
    }

    private function filters(SearchQuery $query, string $scope, ?array $plan): string {
        // the scope by path; for "/" this also leaves out detached subtrees ("#<id>/...")
        $where = ['n.id != ' . SearchIndex::ROOT_ID, 'p.path >= ' . $this->bind($scope) . ' AND p.path < ' . $this->bind(SearchEngine::upper($scope))];
        foreach ($query->terms as $term) {
            $where[] = 'instr(n.key, ' . $this->bind($term) . ') > 0';
        }
        foreach ($query->excludes as $term) {
            $where[] = 'instr(n.key, ' . $this->bind($term) . ') = 0';
        }
        foreach ($query->globs as $glob) {
            $where[] = 'n.key GLOB ' . $this->bind($glob);
        }
        if ($query->regex !== null) {
            $where[] = 'h6re(n.name)';
        }
        if ($plan !== null) {
            $where[] = $this->acl($plan);
        }
        return implode(' AND ', $where);
    }

    // Acl::level() and is_reachable() as SQL. Prefixes are compared as byte ranges (substr()
    // counts characters), on paths normalised like Acl::normalize_path (backslash = slash).
    private function acl(array $plan): string {
        $level = function (string $col) use ($plan): string {
            $x = "replace($col, char(92), '/')";
            if (!$plan['rules']) {
                return (string) (int) $plan['default'];
            }
            $sql = 'CASE';
            foreach ($plan['rules'] as [$path, $lvl]) {
                $sql .= " WHEN $x >= " . $this->bind($path) . " AND $x < " . $this->bind(SearchEngine::upper($path)) . ' THEN ' . (int) $lvl;
            }
            return $sql . ' ELSE ' . (int) $plan['default'] . ' END';
        };
        $dir = $level('n.path') . ' >= ' . Acl::LIST;
        if ($plan['reachable']) {
            $dir .= " OR replace(n.path, char(92), '/') IN (" . implode(', ', array_map(fn ($p) => $this->bind($p), $plan['reachable'])) . ')';
        }
        return "(CASE WHEN n.is_dir = 1 THEN ($dir) ELSE (" . $level('p.path') . ' >= ' . Acl::LIST . ') END)';
    }

    // ---- query shapes ----------------------------------------------------------------------

    private function fts_window(SearchQuery $query, string $scope, ?array $plan, int $lo, int $hi, int $limit, int $fetch): array {
        $candidates = 'SELECT rowid AS id FROM node_fts WHERE node_fts MATCH ' . $this->bind($query->fts_match())
            . ' AND rowid BETWEEN ' . $this->bind($lo) . ' AND ' . $this->bind($hi) . ' LIMIT ' . $this->bind($limit);
        $count = (int) $this->run("SELECT count(*) FROM ($candidates)")->fetchColumn();
        if ($count === 0) {
            return [0, []];
        }
        $candidates = 'SELECT rowid AS id FROM node_fts WHERE node_fts MATCH ' . $this->bind($query->fts_match())
            . ' AND rowid BETWEEN ' . $this->bind($lo) . ' AND ' . $this->bind($hi) . ' LIMIT ' . $this->bind($limit);
        $sql = 'SELECT ' . SearchEngine::COLUMNS . ', ' . $this->rank($query)
            . " FROM ($candidates) c CROSS JOIN node n ON n.id = c.id CROSS JOIN node p ON p.id = n.parent"
            . ' WHERE ' . $this->filters($query, $scope, $plan)
            . ' ORDER BY ' . SearchEngine::ORDER . ' LIMIT ' . $this->bind($fetch);
        return [$count, $this->run($sql)->fetchAll()];
    }

    // The best matches, through the key index whatever the size of the tree: the first word as
    // the whole name (or with an extension: "ubuntu.iso"), then names starting with it. Returns
    // [rows, cut]: cut if there were more names starting with it than were looked at.
    private function prefix_tier(SearchQuery $query, string $scope, ?array $plan, array $ranges, int $fetch): array {
        $t = $query->rank_term();
        if (!$ranges) {
            return [[], false];
        }
        $tier = function (string $candidates) use ($query, $scope, $plan, $ranges, $fetch) {
            // bound per statement: run() starts the names over
            $in_ranges = [];
            foreach ($ranges as [$lo, $hi]) {
                $in_ranges[] = 'n.id BETWEEN ' . $this->bind($lo) . ' AND ' . $this->bind($hi);
            }
            $sql = 'SELECT ' . SearchEngine::COLUMNS . ', ' . $this->rank($query)
                . " FROM ($candidates) c CROSS JOIN node n ON n.id = c.id CROSS JOIN node p ON p.id = n.parent"
                . ' WHERE (' . implode(' OR ', $in_ranges) . ') AND ' . $this->filters($query, $scope, $plan)
                . ' ORDER BY ' . SearchEngine::ORDER . ' LIMIT ' . $this->bind($fetch);
            return $this->run($sql)->fetchAll();
        };
        // "ubuntu.iso" sorts after "ubuntu-..." and "ubuntu_...": its own lookup, so a cut-off
        // prefix tier never loses the exact matches
        $exact = $tier('SELECT id FROM node WHERE key = ' . $this->bind($t) . ' UNION ALL SELECT id FROM node WHERE key >= '
            . $this->bind($t . '.') . ' AND key < ' . $this->bind($t . ".\xFF") . ' LIMIT ' . SearchEngine::EXACT_CANDIDATES);
        $count = 'SELECT count(*) FROM (SELECT 1 FROM node WHERE key >= ' . $this->bind($t) . ' AND key < '
            . $this->bind($t . "\xFF") . ' LIMIT ' . (SearchEngine::PREFIX_CANDIDATES + 1) . ')';
        $cut = (int) $this->run($count)->fetchColumn() > SearchEngine::PREFIX_CANDIDATES;
        $prefix = $tier('SELECT id FROM node WHERE key >= ' . $this->bind($t) . ' AND key < ' . $this->bind($t . "\xFF")
            . ' LIMIT ' . SearchEngine::PREFIX_CANDIDATES);
        return [$this->merge($this->merge([], $exact, $fetch), $prefix, $fetch), $cut];
    }

    private function scan_window(SearchQuery $query, string $scope, ?array $plan, int $lo, int $hi, int $limit): array {
        $sql = 'SELECT ' . SearchEngine::COLUMNS . ', ' . $this->rank($query)
            . ' FROM node n CROSS JOIN node p ON p.id = n.parent'
            . ' WHERE n.id BETWEEN ' . $this->bind($lo) . ' AND ' . $this->bind($hi) . ' AND ' . $this->filters($query, $scope, $plan)
            . ' ORDER BY ' . SearchEngine::ORDER . ' LIMIT ' . $this->bind($limit);
        $rows = [];
        try {
            $st = $this->run($sql);
            while (($row = $st->fetch()) !== false) {
                $rows[] = $row;
            }
        } catch (Throwable $err) {
            // the REGEXP callback's exception comes back as is or wrapped in a PDOException
            if (!$this->timed_out) {
                throw $err;
            }
        }
        return $rows;
    }

    // REGEXP on the real name. Throws out of SQLite once the deadline has passed, which is the
    // only way to stop a running statement from PHP; rows fetched so far are kept.
    private function register_regex(string $pattern, float $deadline): void {
        $calls = 0;
        SearchIndex::create_function($this->db, 'h6re', function ($name) use ($pattern, $deadline, &$calls) {
            if ((++$calls & 255) === 0 && microtime(true) >= $deadline) {
                $this->timed_out = true;
                throw new RuntimeException('search time limit');
            }
            return is_string($name) && @preg_match($pattern, $name) === 1 ? 1 : 0;
        }, 1);
    }
}

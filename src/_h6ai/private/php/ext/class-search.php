<?php
declare(strict_types=1);

// The search API: admission control, the index (SearchEngine) or the fallback walk, and the
// final per-result checks. See docs/SEARCH.md.
//
// The per-result check is the security boundary: whatever the index says, a result is only
// returned if a listing would show it to this user right now (hidden names and ancestors,
// unmanaged folders and nested installs, hideIf403 along the path, permissions, still exists).
final class Search {
    private const MAX_DEPTH = 32;
    private const MAX_RESULTS = 1000;
    private const DEFAULT_MAX_RESULTS = 200;
    private const DEFAULT_TIME_LIMIT = 3;
    private const BACKTRACK_LIMIT = '100000';
    private const SLOT_WAIT = 0.15;

    private array $folder_ok = [];
    private array $readable = [];

    public function __construct(private readonly Context $context) {}

    private function option(string $key, mixed $default): mixed {
        return $this->context->query_option('search.' . $key, $default);
    }

    // Returns ['items' => [...], 'info' => [...]]. Exits with 400/429/503 on bad input or overload.
    public function run(mixed $href, string $input, bool $legacy_pattern, bool $ignorecase): array {
        $started = microtime(true);
        $root = $this->context->to_path($href);
        $info = ['indexed' => false, 'more' => false, 'truncated' => false];
        if ($root === null || !$this->context->is_managed_path($root)) {
            return ['items' => [], 'info' => $info];
        }

        $allow_regex = $this->option('regex', true) !== false;
        $query = $legacy_pattern
            ? SearchQuery::parse('re:' . $input, true, $allow_regex)
            : SearchQuery::parse($input, $this->option('advanced', true) !== false, $allow_regex);
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, $query->error, $query->error !== '');
        if ($query->is_empty()) {
            return ['items' => [], 'info' => $info];
        }
        if ($query->regex !== null) {
            // bound catastrophic backtracking (ReDoS)
            ini_set('pcre.backtrack_limit', Search::BACKTRACK_LIMIT);
            ini_set('pcre.recursion_limit', Search::BACKTRACK_LIMIT);
            Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'invalid pattern', @preg_match($query->regex_pattern($ignorecase), '') === false);
        }

        $this->rate_limit();
        $slot = $this->acquire_slot();
        try {
            $want = max(1, min(Search::MAX_RESULTS, (int) $this->option('maxResults', Search::DEFAULT_MAX_RESULTS)));
            $deadline = $started + max(0.5, (float) $this->option('timeLimit', Search::DEFAULT_TIME_LIMIT));
            $result = $this->from_index($root, $query, $want, $deadline, $ignorecase, $reason);
            if ($result === null) {
                $result = $this->from_walk($root, $query, $want, $deadline, $ignorecase);
            }
        } finally {
            if (is_resource($slot)) {
                flock($slot, LOCK_UN);
                fclose($slot);
            }
        }

        $info = ['indexed' => $result['indexed'], 'more' => $result['more'], 'truncated' => $result['truncated']];
        // how much work a search did, and in which state the index is, is for admins only
        if ($this->context->is_admin()) {
            $info['ms'] = (int) round((microtime(true) - $started) * 1000);
            $info['reason'] = $reason;
            $info['indexAge'] = $result['age'] ?? null;
            $info['stale'] = $result['stale'] ?? false;
        }
        return ['items' => $result['items'], 'info' => $info];
    }

    // ---- admission -------------------------------------------------------------------------

    private function rate_limit(): void {
        $max = (int) $this->context->query_option('search.rateLimit.max', 60);
        if ($max <= 0) {
            return;
        }
        $window = max(1, (int) $this->context->query_option('search.rateLimit.window', 10));
        $cache = (string) $this->context->get_setup()->get('CACHE_PRV_PATH');
        if (random_int(1, 100) === 1) {
            // per-client files of both limiters; nothing in them matters after a day
            foreach (glob($cache . '/ratelimit-*.json.php') ?: [] as $file) {
                if ((int) @filemtime($file) < time() - 86400) {
                    @unlink($file);
                }
            }
        }
        $limiter = new RateLimiter($cache, 'search|' . $this->context->get_request()->client_ip(), $max, $window);
        if (!$limiter->take()) {
            header('Retry-After: ' . $window);
            Util::json_fail(Util::ERR_RATE_LIMITED, 'too many searches, wait a moment');
        }
    }

    // At most search.concurrency searches run at the same time, so they can never take all PHP
    // workers away from downloads and listings. A slot is a lock file; a crashed worker's lock is
    // released by the kernel. With every slot taken, a request may wait up to 150 ms for one, but
    // only as many requests wait as there are slots: the rest get 503 at once (the browser retries
    // later). Searches hold at most 2 x concurrency workers, running or waiting.
    private function acquire_slot(): mixed {
        $slots = max(1, min(64, (int) $this->option('concurrency', 4)));
        $dir = $this->context->get_setup()->get('CACHE_PRV_PATH') . '/search-slots';
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
        if (!is_dir($dir) || !is_writable($dir)) {
            return null; // no writable cache: no limit (logged once per request)
        }
        $take = function (string $kind) use ($dir, $slots): mixed {
            $offset = random_int(0, $slots - 1);
            for ($i = 0; $i < $slots; $i += 1) {
                $fp = @fopen($dir . '/' . $kind . '-' . (($offset + $i) % $slots) . '.lock', 'c');
                if ($fp !== false && flock($fp, LOCK_EX | LOCK_NB)) {
                    return $fp;
                }
                if ($fp !== false) {
                    fclose($fp);
                }
            }
            return null;
        };
        $slot = $take('slot');
        if ($slot === null && ($queue = $take('wait')) !== null) {
            $deadline = microtime(true) + Search::SLOT_WAIT;
            while ($slot === null && microtime(true) < $deadline) {
                usleep(20000);
                $slot = $take('slot');
            }
            flock($queue, LOCK_UN);
            fclose($queue);
        }
        if ($slot === null) {
            header('Retry-After: 1');
            Util::json_fail(Util::ERR_BUSY, 'search is busy, try again in a moment');
        }
        return $slot;
    }

    // ---- index -----------------------------------------------------------------------------

    private function from_index(string $root, SearchQuery $query, int $want, float $deadline, bool $ignorecase, ?string &$reason): ?array {
        $index = new SearchIndex($this->context);
        if (!$index->is_enabled()) {
            $reason = 'the index is disabled';
            return null;
        }
        if ($this->context->get_setup()->get('HAS_WRITABLE_CACHE_PRV')) {
            $index->record_site();
        }
        $reader = $index->open_reader($reason);
        if ($reader === null) {
            return null;
        }
        $plan = $this->context->get_acl()->search_plan();
        $fetch = $want + max(10, intdiv($want, 4)) + 1;
        $engine = new SearchEngine($reader['db'], $reader['meta']);
        $scope_rel = $this->index_path($root);
        $found = $engine->search($scope_rel, $query, $plan, $fetch, max(1000, (int) $this->option('candidates', 20000)), $deadline, $ignorecase);
        if (!$found['found']) {
            $reason = 'this folder is not in the index yet';
            return null;
        }
        $rows = $found['rows'];

        $items = [];
        $more = false;
        foreach ($rows as $row) {
            $parent = $this->abs((string) $row['ppath']);
            $abs = $parent === '/' ? '/' . $row['name'] : $parent . '/' . $row['name'];
            if (!$this->is_visible($parent, (string) $row['name'], $abs, (bool) $row['is_dir'])) {
                continue;
            }
            $item = $this->item($abs, (bool) $row['is_dir']);
            if ($item === null) {
                continue;
            }
            if (count($items) >= $want) {
                $more = true;
                break;
            }
            $items[] = $item;
        }
        // every candidate used up without filling the page: there may be more beyond them
        $more = $more || count($rows) >= $fetch;
        $age = isset($reader['meta']['pass_end']) ? time() - (int) $reader['meta']['pass_end'] : null;
        return ['items' => $items, 'indexed' => true, 'more' => $more, 'truncated' => $found['truncated'], 'age' => $age, 'stale' => $reader['stale']];
    }

    // The index stores folder paths exactly as on disk, relative to the root: "/a/b/".
    private function index_path(string $abs): string {
        $root = (string) $this->context->get_setup()->get('ROOT_PATH');
        return $abs === $root ? '/' : substr($abs, strlen($root)) . '/';
    }

    private function abs(string $index_path): string {
        $root = (string) $this->context->get_setup()->get('ROOT_PATH');
        return $index_path === '/' ? $root : $root . substr($index_path, 0, -1);
    }

    // ---- per-result checks -----------------------------------------------------------------

    private function is_readable_dir(string $dir): bool {
        return $this->readable[$dir] ??= @is_readable($dir);
    }

    // A folder whose entries a listing would show: managed (not hidden itself or by an
    // ancestor, not unmanaged, not inside a nested install) and, with hideIf403, every folder
    // on the way down readable.
    private function folder_ok(string $dir): bool {
        if (isset($this->folder_ok[$dir])) {
            return $this->folder_ok[$dir];
        }
        $ok = $this->context->is_managed_path($dir);
        if ($ok && $this->context->query_option('view.hideIf403', false)) {
            $root = (string) $this->context->get_setup()->get('ROOT_PATH');
            for ($path = $dir; $ok && $path !== $root && strlen($path) > strlen($root); $path = dirname($path)) {
                $ok = $this->is_readable_dir($path);
            }
        }
        return $this->folder_ok[$dir] = $ok;
    }

    private function is_visible(string $parent, string $name, string $abs, bool $is_dir): bool {
        if (!$this->folder_ok($parent)) {
            return false;
        }
        if ($this->context->is_hidden($name) || $this->context->is_hidden($this->context->to_href($parent) . $name)
            || $abs === $this->context->get_setup()->get('H6AI_PATH')) {
            return false;
        }
        if ($this->context->query_option('view.hideIf403', false) && !@is_readable($abs)) {
            return false;
        }
        // read_dir(): files need "list" on their folder, folders must be reachable
        return $is_dir ? $this->context->is_reachable($abs) : $this->context->can($parent, Acl::LIST);
    }

    // Like Item::to_json_object, from one stat. Folder sizes only from the folder size cache: a
    // search never sums up folders.
    private function item(string $abs, ?bool $expect_dir): ?array {
        $st = @stat($abs);
        if ($st === false) {
            return null;
        }
        $is_dir = ($st['mode'] & 0170000) === 0040000;
        if ($expect_dir !== null && $is_dir !== $expect_dir) {
            return null;
        }
        $item = [
            'href' => $this->context->to_href($abs, $is_dir),
            'time' => (int) $st['mtime'] * 1000,
            'size' => $is_dir ? Filesize::cached_folder_size($this->context, $abs) : (int) $st['size']
        ];
        if ($is_dir) {
            $item['managed'] = $this->context->is_managed_path($abs);
            $item['fetched'] = false;
        }
        return $item;
    }

    // ---- fallback: walk the tree -----------------------------------------------------------

    // Breadth first, with limits on depth, results and time, under the same admission control.
    // Symlinked folders are visited once (by real path) to survive symlink cycles. read_dir()
    // applies the visitor's permissions.
    // Without the index: breadth first through the folders, until enough matches or the deadline.
    // Symlinked folders as in the index (SearchIndexer::folder_flags): only links to folders
    // outside the tree are followed, each target once.
    private function from_walk(string $root, SearchQuery $query, int $want, float $deadline, bool $ignorecase): array {
        $found = [];
        $queue = [[$root, 0]];
        $more = false;
        $head = 0;
        $term = $query->rank_term();
        $root_path = (string) $this->context->get_setup()->get('ROOT_PATH');
        $root_real = rtrim((string) (realpath($root_path) ?: $root_path), '/') . '/';
        $targets = [];
        while ($head < count($queue) && !$more) {
            if (microtime(true) >= $deadline) {
                break;
            }
            [$dir, $depth] = $queue[$head];
            $queue[$head++] = null;
            if (!$this->context->is_managed_path($dir)) {
                continue;
            }
            foreach ($this->context->read_dir($dir) as $name) {
                $name = (string) $name;
                $path = $dir . '/' . $name;
                $is_dir = @is_dir($path);
                if ($query->matches_name($name, $ignorecase)) {
                    $item = $this->item($path, $is_dir);
                    if ($item !== null) {
                        if (count($found) >= $want) {
                            $more = true;
                            break;
                        }
                        $key = SearchQuery::fold($name);
                        $found[] = ['item' => $item, 'r' => SearchEngine::rank_php($key, $term), 'is_dir' => (int) $is_dir,
                            'kl' => mb_strlen($key), 'pl' => strlen($dir), 'key' => $key, 'id' => count($found)];
                    }
                }
                if (!$is_dir || $depth >= Search::MAX_DEPTH) {
                    continue;
                }
                if (@is_link($path)) {
                    $target = realpath($path);
                    $target = $target === false ? null : rtrim($target, '/') . '/';
                    $follow = $target !== null && !str_starts_with($target, $root_real) && !str_starts_with($root_real, $target);
                    foreach ($follow ? $targets : [] as $other) {
                        $follow = $follow && !str_starts_with($target, $other) && !str_starts_with($other, $target);
                    }
                    if (!$follow) {
                        continue;
                    }
                    $targets[] = $target;
                }
                $queue[] = [$path, $depth + 1];
            }
        }
        $complete = $head >= count($queue);
        usort($found, [SearchEngine::class, 'cmp']);
        return ['items' => array_column($found, 'item'), 'indexed' => false, 'more' => $more, 'truncated' => !$more && !$complete];
    }
}

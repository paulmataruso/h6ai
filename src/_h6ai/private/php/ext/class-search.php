<?php
declare(strict_types=1);

final class Search {
    private const MAX_PATTERN_LENGTH = 1000;
    private const MAX_DEPTH = 32;
    private const DEFAULT_MAX_RESULTS = 1000;
    private const DEFAULT_TIME_LIMIT = 10;
    private const BACKTRACK_LIMIT = '100000';

    public function __construct(private readonly Context $context) {}

    // Breadth first walk with limits on depth, results and time. Symlinked directories are
    // only visited once (by real path) to survive symlink cycles.
    public function get_paths(string $root, string $re): array {
        $max_results = max(1, (int) $this->context->query_option('search.maxResults', Search::DEFAULT_MAX_RESULTS));
        $deadline = microtime(true) + max(1, (int) $this->context->query_option('search.timeLimit', Search::DEFAULT_TIME_LIMIT));

        $paths = [];
        $visited = [];
        $queue = [[$root, 0]];

        while ($queue && count($paths) < $max_results && microtime(true) < $deadline) {
            [$dir, $depth] = array_shift($queue);
            $real = realpath($dir);
            if ($real === false || isset($visited[$real]) || !$this->context->is_managed_path($dir)) {
                continue;
            }
            $visited[$real] = true;

            foreach ($this->context->read_dir($dir) as $name) {
                $path = $dir . '/' . $name;
                if (@preg_match($re, $name) === 1) {
                    $paths[] = $path;
                    if (count($paths) >= $max_results) {
                        break;
                    }
                }
                if ($depth < Search::MAX_DEPTH && @is_dir($path)) {
                    $queue[] = [$path, $depth + 1];
                }
            }
        }

        return $paths;
    }

    public function get_items(mixed $href, string $pattern, bool $ignorecase = false): array {
        $root = $this->context->to_path($href);
        if ($root === null || $pattern === '' || !$this->context->is_managed_path($root)) {
            return [];
        }

        Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'pattern too long', strlen($pattern) > Search::MAX_PATTERN_LENGTH);
        $re = Util::wrap_pattern($pattern) . 'u' . ($ignorecase ? 'i' : '');

        // bound catastrophic backtracking (ReDoS)
        ini_set('pcre.backtrack_limit', Search::BACKTRACK_LIMIT);
        ini_set('pcre.recursion_limit', Search::BACKTRACK_LIMIT);
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'invalid pattern', @preg_match($re, '') === false);

        $cache = [];
        $items = [];
        foreach ($this->get_paths($root, $re) as $path) {
            $item = Item::get($this->context, $path, $cache);
            if ($item !== null) {
                $items[] = $item->to_json_object();
            }
        }
        return $items;
    }
}

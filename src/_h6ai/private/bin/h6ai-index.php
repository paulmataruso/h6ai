<?php
declare(strict_types=1);

// The search index from the shell (see docs/SEARCH.md).
//
//   php _h6ai/private/bin/h6ai-index.php status [--json]
//   php _h6ai/private/bin/h6ai-index.php refresh [--verify]   one pass now (builds if needed)
//   php _h6ai/private/bin/h6ai-index.php rebuild              a new index from scratch
//   php _h6ai/private/bin/h6ai-index.php daemon               keeps the index current (Docker, systemd)
//   php _h6ai/private/bin/h6ai-index.php search [--in /folder/] [--all] [--limit N] WORDS...
//
// Run it as the PHP-FPM user (it must see the files as PHP-FPM does: unreadable files are
// hidden). Started as root it switches to the owner of private/cache. Run it at low priority:
//   nice -n 19 ionice -c3 php .../h6ai-index.php daemon
// `search` searches as an anonymous visitor would; --all ignores folder permissions.

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$private_path = dirname(__DIR__);
if (!defined('H6AI_VERSION')) {
    $index_php = @file_get_contents(dirname($private_path) . '/public/index.php');
    define('H6AI_VERSION', is_string($index_php) && preg_match("/define\\('H6AI_VERSION', '([^']*)'\\)/", $index_php, $m) ? $m[1] : 'cli');
}
if (!defined('MIN_PHP_VERSION')) {
    define('MIN_PHP_VERSION', '8.2.0');
}

require_once $private_path . '/php/class-bootstrap.php';
spl_autoload_register([Bootstrap::class, 'autoload']);
setlocale(LC_CTYPE, 'en_US.UTF-8', 'C.UTF-8');

function out(string $msg): void {
    fwrite(STDERR, '[' . gmdate('Y-m-d H:i:s') . '] h6ai-index: ' . $msg . PHP_EOL);
}

function fail(string $msg, int $status = 1): never {
    fwrite(STDERR, 'h6ai-index: ' . $msg . PHP_EOL);
    exit($status);
}

// The index and its WAL must belong to the PHP-FPM user, and the tree must be seen with its
// permissions: drop to the owner of private/cache.
function drop_privileges(string $path): void {
    if (!function_exists('posix_geteuid') || posix_geteuid() !== 0) {
        return;
    }
    $owner = @fileowner($path);
    $group = @filegroup($path);
    if ($owner === false || $owner === 0) {
        fail('refusing to run as root: ' . $path . ' belongs to root, run this as the PHP-FPM user');
    }
    $user = posix_getpwuid($owner);
    if (!posix_setgid((int) $group) || ($user && !posix_initgroups($user['name'], (int) $group)) || !posix_setuid($owner)) {
        fail('cannot switch to the owner of ' . $path);
    }
}

// The same Setup as PHP-FPM: paths and hrefs come from the web server, which h6ai records.
function make_context(string $cache_path): Context {
    $site = SearchIndex::read_site($cache_path) ?? [];
    $_SERVER['REQUEST_METHOD'] = 'GET';
    $_SERVER['REQUEST_URI'] = '/';
    $_SERVER['SCRIPT_NAME'] = is_string($site['scriptName'] ?? null) && $site['scriptName'] !== '' ? $site['scriptName'] : '/_h6ai/public/index.php';
    $_SERVER['SERVER_SOFTWARE'] = 'nginx';
    $_SERVER['DOCUMENT_ROOT'] = is_string($site['documentRoot'] ?? null) ? $site['documentRoot'] : '';
    if (!empty($site['serverConf'])) {
        $_SERVER['H6AI_SERVER_CONF'] = '1';
    }
    if (is_string($site['filesFolder'] ?? null) && $site['filesFolder'] !== '' && getenv('H6AI_FILES_FOLDER') === false) {
        putenv('H6AI_FILES_FOLDER=' . $site['filesFolder']);
    }
    $setup = new Setup(false);
    if (isset($site['rootPath']) && $site['rootPath'] !== $setup->get('ROOT_PATH')) {
        out('warning: PHP-FPM shares ' . $site['rootPath'] . ' but this sees ' . $setup->get('ROOT_PATH'));
    }
    return new Context(new Session(false), Request::from_globals(), $setup);
}

function code_signature(string $private_path): string {
    $sig = '';
    foreach (array_merge([__FILE__], glob($private_path . '/php/*/class-search*.php') ?: []) as $file) {
        $sig .= $file . @filemtime($file) . ';';
    }
    return md5($sig);
}

$args = array_slice($argv, 1);
$command = $args[0] ?? '';
$flags = [];
$words = [];
for ($i = 1; $i < count($args); $i += 1) {
    if (in_array($args[$i], ['--in', '--limit'], true)) {
        $flags[$args[$i]] = $args[++$i] ?? '';
    } elseif (str_starts_with($args[$i], '--')) {
        $flags[$args[$i]] = true;
    } else {
        $words[] = $args[$i];
    }
}

$cache_path = $private_path . '/cache';
drop_privileges($cache_path);
$context = make_context($cache_path);
$index = new SearchIndex($context);

switch ($command) {
    case 'status':
        $status = $index->status();
        if (isset($flags['--json'])) {
            echo json_encode($status, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), PHP_EOL;
            exit(0);
        }
        printf("search enabled   %s\n", $status['enabled'] ? 'yes' : 'no (search.enabled / search.index.enabled)');
        printf("SQLite           %s%s\n", $status['sqlite'] ?? '-', $status['supported'] ? '' : ' (unsupported)');
        printf("index            %s\n", $status['usable'] ? 'ready' . ($status['stale'] ? ', configuration changed: rebuild pending' : '') : 'not usable: ' . $status['reason']);
        if ($status['usable']) {
            printf("entries          %d (%d folders), %.1f MiB, %d added since the build\n", $status['entries'], $status['folders'], $status['bytes'] / 1048576, max(0, $status['delta']));
            printf("built            %s (%.1f s)\n", gmdate('Y-m-d H:i:s', (int) $status['built']) . ' UTC', (float) $status['buildSeconds']);
        }
        if ($status['lastPass']) {
            $p = $status['lastPass'];
            printf("last pass        %s: %.1f s, %d folders checked, %d re-listed, %d changes\n", gmdate('Y-m-d H:i:s', $p['at']) . ' UTC', $p['seconds'], $p['folders'], $p['rescanned'], $p['changes']);
        }
        if ($status['building']) {
            printf("building         generation %d, %d entries so far\n", $status['building']['gen'], $status['building']['entries'] ?? 0);
        }
        printf("indexer daemon   %s\n", $status['daemon'] ? 'running' : 'not seen (web requests do the work in slices)');
        exit(0);

    case 'refresh':
    case 'rebuild':
        if (!$index->is_enabled()) {
            out('note: search or the search index is disabled in the options');
        }
        $mode = $command === 'rebuild' ? 'rebuild' : (isset($flags['--verify']) ? 'verify' : 'refresh');
        $started = microtime(true);
        $indexer = new SearchIndexer($context, $index, 'out');
        // with no usable index, a refresh builds one
        $result = $indexer->run(INF, $mode, true);
        if ($result['did'] === 'busy') {
            fail('another indexer is running', 3);
        }
        if (in_array($result['did'], ['unsupported', 'error'], true)) {
            fail($result['msg'] ?? $result['did']);
        }
        out(sprintf('%s done in %.1f s: %d folders, %d re-listed, %d changes', $result['did'], microtime(true) - $started,
            $result['folders'] ?? 0, $result['rescanned'] ?? 0, $result['changes'] ?? 0));
        exit(0);

    case 'daemon':
        $signature = code_signature($private_path);
        out('started (pid ' . getmypid() . ')');
        while (true) {
            clearstatcache(true);
            $context = make_context($cache_path);
            $index = new SearchIndex($context);
            $index->touch_stamp('daemon');
            if ($index->is_enabled() && SearchIndex::support()['ok']) {
                try {
                    $indexer = new SearchIndexer($context, $index, 'out', fn () => $index->touch_stamp('daemon'));
                    $started = microtime(true);
                    $result = $indexer->run(INF, 'auto', true);
                    if (!in_array($result['did'], ['idle', 'busy'], true)) {
                        out(sprintf('%s in %.1f s: %d folders, %d re-listed, %d changes', $result['did'], microtime(true) - $started,
                            $result['folders'] ?? 0, $result['rescanned'] ?? 0, $result['changes'] ?? 0));
                    }
                } catch (Throwable $err) {
                    out('error: ' . $err->getMessage());
                }
            }
            $index->touch_stamp('daemon');
            sleep(max(5, min(30, (int) $index->option('refreshInterval', 300))));
            if (code_signature($private_path) !== $signature) {
                out('h6ai was updated, restarting');
                exit(0);
            }
        }

    case 'search':
        $q = implode(' ', $words);
        $reason = '';
        $reader = $index->open_reader($reason);
        if ($reader === null) {
            fail('no usable index: ' . $reason);
        }
        $query = SearchQuery::parse($q, true, true);
        if ($query->error !== '' || $query->is_empty()) {
            fail($query->error ?: 'nothing to search for');
        }
        $scope = is_string($flags['--in'] ?? null) ? Acl::normalize_path($flags['--in']) : '/';
        $limit = max(1, (int) ($flags['--limit'] ?? 20));
        $plan = isset($flags['--all']) ? null : $context->get_acl()->search_plan();
        $engine = new SearchEngine($reader['db'], $reader['meta']);
        $started = hrtime(true);
        $found = $engine->search($scope, $query, $plan, $limit, 20000, microtime(true) + 10, true);
        $ms = (hrtime(true) - $started) / 1e6;
        if (!$found['found']) {
            fail('folder not in the index: ' . $scope);
        }
        foreach ($found['rows'] as $row) {
            printf("%d  %s%s%s\n", $row['r'], $row['ppath'], $row['name'], $row['is_dir'] ? '/' : '');
        }
        out(sprintf('%d results in %.1f ms%s', count($found['rows']), $ms, $found['truncated'] ? ' (truncated)' : ''));
        exit(0);

    default:
        fwrite(STDERR, "usage: h6ai-index.php status [--json] | refresh [--verify] | rebuild | daemon | search [--in /folder/] [--all] [--limit N] WORDS...\n");
        exit(2);
}

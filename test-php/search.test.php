<?php
declare(strict_types=1);

// Search index tests (see docs/SEARCH.md), run by test-php/run.sh inside the PHP image as a
// non-root user, on a copy of _h6ai in a temporary folder:
//
//   1. folding and query parsing
//   2. the SQL permission filter decides exactly like Acl::level() / is_reachable()
//      (randomised rule sets, anon accounts, user grants, unicode and backslash paths)
//   3. the indexer: after every round of random changes to a real tree (new, deleted, renamed and
//      moved files and folders, type changes, index.html appearing, chmod 000, hidden names,
//      symlinks), a refresh pass leaves exactly what an independent walk with the listing code sees
//   4. the engine: random queries in random folders, with and without permission rules, return
//      exactly the entries a walk would (scoping by id ranges, added and moved entries), and a
//      short page is the top of the full ranking
//   5. the per-result checks: hideIf403, unmanaged folders, nested installs, hidden hrefs
//   6. admission: concurrency slots and the bounded wait for one

if (PHP_SAPI !== 'cli') {
    exit(1);
}

$seed = (int) (getenv('SEED') ?: random_int(1, 1000000));
$rounds = (int) (getenv('ROUNDS') ?: 12);
mt_srand($seed);
echo "seed $seed\n";

$base = sys_get_temp_dir() . '/h6ai-search-test-' . getmypid();
$src = $argv[1] ?? '/src/_h6ai';
exec('rm -rf ' . escapeshellarg($base) . ' && mkdir -p ' . escapeshellarg($base) . ' && cp -r ' . escapeshellarg($src) . ' ' . escapeshellarg($base . '/_h6ai'));
register_shutdown_function(fn () => exec('chmod -R u+rwx ' . escapeshellarg($base) . ' 2>/dev/null; rm -rf ' . escapeshellarg($base)));
$root = $base . '/files';
mkdir($root);
// the share is a subfolder: _h6ai lives in it, like a real install
exec('mv ' . escapeshellarg($base . '/_h6ai') . ' ' . escapeshellarg($root . '/_h6ai'));
file_put_contents($root . '/_h6ai/private/conf/options.local.json', json_encode([
    'search' => ['enabled' => true, 'index' => ['enabled' => true, 'maxEntriesPerFolder' => 100000]],
    // readability is not the index's business (checked live per result, see the end)
    'view' => ['hidden' => ['^\\.', '^_h6ai', '^_h5ai', '^/secretplace$'], 'hideIf403' => false],
    'foldersize' => ['enabled' => false]
]));

define('H6AI_VERSION', 'test');
define('MIN_PHP_VERSION', '8.2.0');
require_once $root . '/_h6ai/private/php/class-bootstrap.php';
spl_autoload_register([Bootstrap::class, 'autoload']);
$_SERVER['SCRIPT_NAME'] = '/_h6ai/public/index.php';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['SERVER_SOFTWARE'] = 'nginx';
$_SERVER['H6AI_SERVER_CONF'] = '1';

$failures = 0;
$checks = 0;
function check(bool $ok, string $what): void {
    global $failures, $checks;
    $checks += 1;
    if (!$ok) {
        $failures += 1;
        echo "  FAIL: $what\n";
    }
}
function same_set(array $got, array $want, string $what): void {
    sort($got);
    sort($want);
    $missing = array_diff($want, $got);
    $extra = array_diff($got, $want);
    check(!$missing && !$extra, $what . ($missing ? ' missing ' . json_encode(array_slice(array_values($missing), 0, 5), JSON_UNESCAPED_UNICODE) : '')
        . ($extra ? ' extra ' . json_encode(array_slice(array_values($extra), 0, 5), JSON_UNESCAPED_UNICODE) : ''));
}
function ctx(): Context {
    return new Context(new Session(false), Request::from_globals(), new Setup(false));
}

// ---- 1. folding and parsing ---------------------------------------------------------------
echo "1. folding and parsing\n";
check(SearchQuery::fold('ÀÉÎõü') === 'aeiou', 'fold latin accents');
check(SearchQuery::fold('Straße') === 'strasse', 'fold sharp s');
check(SearchQuery::fold("Cafe\u{301}") === 'cafe', 'fold NFD combining mark');
check(SearchQuery::fold('README.TXT') === 'readme.txt', 'fold ascii');
check(SearchQuery::fold('日本語') === '日本語', 'fold leaves CJK');
$q = SearchQuery::parse('Ubuntu "Release Notes" -draft *.ISO', true, true);
check($q->terms === ['ubuntu', 'release notes'], 'terms ' . json_encode($q->terms));
check($q->excludes === ['draft'], 'excludes');
check($q->globs === ['*.iso'], 'globs ' . json_encode($q->globs));
check($q->fragments() === ['ubuntu', 'release notes', '.iso'], 'fragments ' . json_encode($q->fragments()));
check(SearchQuery::parse('a [b]*', true, true)->globs === ['[[]b[]]*'], 'brackets are literal in globs');
check(SearchQuery::parse('re:^IMG', true, true)->regex === '^IMG', 'regex');
check(SearchQuery::parse('re:x', true, false)->error !== '', 'regex disabled');
check(SearchQuery::parse('a b c d e f g h i', true, true)->error !== '', 'too many terms');
check(SearchQuery::parse('-x', true, true)->is_empty(), 'exclusion alone is empty');
check(SearchQuery::parse('foo -x', false, true)->terms === ['foo -x'], 'simple mode: one literal');
check(SearchQuery::parse('*', true, true)->is_empty(), 'lone star is no restriction');
$q = SearchQuery::parse('img_20??*', true, true);
check($q->matches_name('IMG_2023_01.jpg') && !$q->matches_name('IMG_2.jpg') && !$q->matches_name('xIMG_2023.jpg'), 'glob semantics');
$q = SearchQuery::parse('notes -old', true, true);
check($q->matches_name('Notes.txt') && !$q->matches_name('old notes.txt'), 'exclusion semantics');

// ---- 2. permission filter parity ----------------------------------------------------------
echo "2. permission filter (SQL vs Acl)\n";
$segments = ['a', 'b', 'team', 'équipe', 'x\\y', 'pub', 'a b'];
$all_dirs = ['/'];
$frontier = ['/'];
for ($depth = 0; $depth < 3; $depth += 1) {
    $next = [];
    foreach ($frontier as $dir) {
        foreach ($segments as $seg) {
            if (mt_rand(0, 2) === 0) {
                $next[] = $dir . $seg . '/';
            }
        }
    }
    $all_dirs = array_merge($all_dirs, $next);
    $frontier = $next;
}
$mem = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$mem->exec('CREATE TABLE node (id INTEGER PRIMARY KEY, parent INTEGER, name TEXT, key TEXT, is_dir INTEGER, path TEXT, hi INTEGER, flags INTEGER DEFAULT 0)');
$ins = $mem->prepare('INSERT INTO node (id, parent, name, key, is_dir, path) VALUES (?, ?, ?, ?, ?, ?)');
$ids = [];
$id = 0;
foreach ($all_dirs as $dir) {
    $id += 1;
    $ids[$dir] = $id;
    $parent = $dir === '/' ? 0 : $ids[substr($dir, 0, strrpos(substr($dir, 0, -1), '/') + 1)];
    $ins->execute([$id, $parent, basename($dir), basename($dir), 1, $dir]);
    $id += 1;
    $ins->execute([$id, $ids[$dir], 'f.txt', 'f.txt', 0, null]);
}
$levels = ['none', 'list', 'read', 'download'];
$engine_ref = new ReflectionClass(SearchEngine::class);
for ($trial = 0; $trial < 300; $trial += 1) {
    $rules = [];
    foreach ((array) array_rand(array_flip($all_dirs), min(count($all_dirs), mt_rand(1, 6))) as $path) {
        $grants = [];
        foreach (['*', 'role:staff', 'role:x', 'user:bob', 'user:anon1'] as $principal) {
            if (mt_rand(0, 2) === 0) {
                $grants[$principal] = $levels[mt_rand(0, 3)];
            }
        }
        $rules[] = ['path' => (string) $path, 'grants' => $grants];
    }
    $who = mt_rand(0, 3);
    $acl = match ($who) {
        0 => new Acl($rules, null, []),
        1 => new Acl($rules, 'bob', ['staff']),
        2 => new Acl($rules, 'anon1', [], true),
        default => new Acl($rules, 'carol', ['x'])
    };
    $plan = $acl->search_plan();
    if ($plan === null) {
        continue;
    }
    $engine = $engine_ref->newInstanceWithoutConstructor();
    $sql = $engine_ref->getMethod('acl')->invoke($engine, $plan);
    $binds = $engine_ref->getProperty('binds')->getValue($engine);
    $st = $mem->prepare("SELECT n.id, n.is_dir, n.path, p.path AS ppath, $sql AS ok FROM node n JOIN node p ON p.id = n.parent");
    foreach ($binds as $name => $value) {
        $st->bindValue($name, $value);
    }
    $st->execute();
    foreach ($st->fetchAll() as $row) {
        $want = (int) $row['is_dir'] === 1 ? $acl->is_reachable(Acl::normalize_path($row['path'])) : $acl->level(Acl::normalize_path($row['ppath'])) >= Acl::LIST;
        if ((bool) $row['ok'] !== $want) {
            check(false, "acl parity trial $trial who $who " . ($row['is_dir'] ? 'dir ' . $row['path'] : 'file in ' . $row['ppath'])
                . ' sql=' . $row['ok'] . ' acl=' . (int) $want . ' rules=' . json_encode($rules, JSON_UNESCAPED_UNICODE));
            break 2;
        }
        $checks += 1;
    }
    // roots: everything visible lies below one of them
    if ($plan['roots'] !== null) {
        foreach ($all_dirs as $dir) {
            if ($acl->level(Acl::normalize_path($dir)) >= Acl::LIST) {
                $covered = false;
                foreach ($plan['roots'] as $r) {
                    $covered = $covered || str_starts_with(Acl::normalize_path($dir), $r);
                }
                check($covered, "listable $dir below a root " . json_encode($plan['roots'], JSON_UNESCAPED_UNICODE));
            }
        }
    }
}

// ---- 3. indexer and 4. engine ---------------------------------------------------------------
$context = ctx();
$index = new SearchIndex($context);
$sup = SearchIndex::support();
if (!$sup['ok']) {
    echo "SKIP 3/4: {$sup['reason']}\n";
    exit($failures ? 1 : 0);
}

$words = ['alpha', 'beta', 'Gamma', 'delta', 'Ünïcödé', 'report', 'notes', 'IMG', 'x', 'ab', 'Straße', '日本語', 'a#b', '100%', 'c++', 'final (2)', 'zz'];
$exts = ['.txt', '.jpg', '.pdf', '', '.tar.gz'];
function rand_name(): string {
    global $words, $exts;
    $n = $words[mt_rand(0, count($words) - 1)];
    if (mt_rand(0, 1)) {
        $n .= ['_', ' ', '-', '.'][mt_rand(0, 3)] . $words[mt_rand(0, count($words) - 1)];
    }
    if (mt_rand(0, 3) === 0) {
        $n .= mt_rand(1, 99);
    }
    if (mt_rand(0, 9) === 0) {
        $n = '.' . $n; // hidden
    }
    return $n . $exts[mt_rand(0, count($exts) - 1)];
}
function all_dirs(string $root): array {
    $out = [$root];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST, RecursiveIteratorIterator::CATCH_GET_CHILD);
    foreach ($it as $path => $info) {
        if ($info->isDir() && !$info->isLink() && !str_contains($path, '/_h6ai')) {
            $out[] = $path;
        }
    }
    return $out;
}
function make_tree(string $dir, int $depth): void {
    for ($i = mt_rand(1, 6); $i > 0; $i -= 1) {
        @file_put_contents($dir . '/' . rand_name(), 'x');
    }
    if ($depth < 4) {
        for ($i = mt_rand(0, 3); $i > 0; $i -= 1) {
            $sub = $dir . '/' . rand_name();
            if (@mkdir($sub)) {
                make_tree($sub, $depth + 1);
            }
        }
    }
}

// The truth: a breadth first walk with the listing code (read_dir: no rules configured, so no
// permissions; is_managed_path decides descending). Symlinked folders are descended only if they
// lead out of the tree and not into or around another one followed (the fixtures never have
// two candidates for the same target, so the walk order doesn't matter).
function reference(Context $ctx, string $root): array {
    $out = [];
    $queue = [$root];
    $root_real = realpath($root) . '/';
    $targets = [];
    while ($queue) {
        $dir = array_shift($queue);
        if (!$ctx->is_managed_path($dir)) {
            continue;
        }
        foreach ($ctx->read_dir($dir) as $name) {
            $abs = $dir . '/' . $name;
            $is_dir = is_dir($abs);
            $rel = ($dir === $root ? '/' : substr($dir, strlen($root)) . '/') . $name . ($is_dir ? '/' : '');
            $out[$rel] = $is_dir;
            if ($is_dir && is_link($abs)) {
                $target = realpath($abs) . '/';
                $follow = !str_starts_with($target, $root_real) && !str_starts_with($root_real, $target);
                foreach ($targets as $other) {
                    $follow = $follow && !str_starts_with($target, $other) && !str_starts_with($other, $target);
                }
                if ($follow) {
                    $targets[] = $target;
                    $queue[] = $abs;
                }
            } elseif ($is_dir) {
                $queue[] = $abs;
            }
        }
    }
    return $out;
}

function snapshot(SearchIndex $index): array {
    $reader = $index->open_reader($reason);
    if ($reader === null) {
        check(false, 'index usable: ' . $reason);
        return [];
    }
    $db = $reader['db'];
    $out = [];
    foreach ($db->query("SELECT n.name, n.is_dir, n.path, p.path AS ppath FROM node n JOIN node p ON p.id = n.parent WHERE n.id != 1 AND p.path >= '/' AND p.path < '0'") as $row) {
        $rel = $row['ppath'] . $row['name'] . ($row['is_dir'] ? '/' : '');
        $out[] = $rel;
        if ($row['is_dir']) {
            check($row['path'] === $rel, "folder path consistent: {$row['path']} vs $rel");
        }
    }
    check((int) $db->query("SELECT count(*) FROM node WHERE path < '/'")->fetchColumn() === 0, 'no detached rows left after a pass');
    try {
        // external content FTS: the triggers must have kept the full-text index exactly in sync
        $index->open($reader['current']['gen'], false)->exec("INSERT INTO node_fts(node_fts, rank) VALUES('integrity-check', 1)");
        check(true, 'fts integrity');
    } catch (Throwable $err) {
        check(false, 'fts integrity: ' . $err->getMessage());
    }
    return $out;
}

function engine_check(SearchIndex $index, Context $ctx, string $root, array $truth, string $label, ?Acl $acl = null): void {
    $reader = $index->open_reader($reason);
    if ($reader === null) {
        return;
    }
    $engine = new SearchEngine($reader['db'], $reader['meta']);
    $plan = $acl?->search_plan();
    $dirs = array_merge(['/'], array_keys(array_filter($truth)));
    $names = array_keys($truth);
    for ($i = 0; $i < 25; $i += 1) {
        $scope = $dirs[mt_rand(0, count($dirs) - 1)];
        $pick = basename(rtrim($names[mt_rand(0, max(0, count($names) - 1))] ?? 'alpha', '/'));
        $fold = SearchQuery::fold($pick);
        $len = mb_strlen($fold);
        $start = mt_rand(0, max(0, $len - 3));
        $kind = mt_rand(0, 4);
        $text = match ($kind) {
            0 => mb_substr($fold, $start, 3),                 // trigram fragment
            1 => mb_substr($fold, $start, 1),                 // short: scan
            2 => '"' . mb_substr($fold, $start, 5) . '"',      // phrase
            3 => mb_substr($fold, 0, 4) . ' -' . mb_substr($fold, max(0, $len - 2)), // with exclusion
            default => '*' . mb_substr($fold, max(0, $len - 2))  // suffix glob
        };
        $query = SearchQuery::parse($text, true, true);
        if ($query->is_empty() || $query->error !== '') {
            continue;
        }
        $want = [];
        foreach ($truth as $rel => $is_dir) {
            $parent = substr(rtrim($rel, '/'), 0, strrpos(rtrim($rel, '/'), '/') + 1);
            $name = basename(rtrim($rel, '/'));
            if (!str_starts_with($parent, $scope) || !$query->matches_name($name)) {
                continue;
            }
            if ($acl !== null) {
                $ok = $is_dir ? $acl->is_reachable(Acl::normalize_path($rel)) : $acl->level(Acl::normalize_path($parent)) >= Acl::LIST;
                // and the walk must get there: every folder above listed
                for ($up = $parent; $ok && $up !== '/' && $up !== $scope; $up = substr($up, 0, strrpos(substr($up, 0, -1), '/') + 1)) {
                    $ok = $acl->is_reachable(Acl::normalize_path($up));
                }
                if (!$ok) {
                    continue;
                }
            }
            $want[] = $rel;
        }
        $found = $engine->search($scope, $query, $plan, 100000, 1000000, microtime(true) + 30, true);
        if (!$found['found']) {
            // not descended (unmanaged, symlinked, nested install): the API walks those instead
            $abs = $scope === '/' ? $root : $root . substr($scope, 0, -1);
            check(is_link($abs) || !$ctx->is_managed_path($abs), "$label: scope $scope found");
            continue;
        }
        $got = array_map(fn ($r) => $r['ppath'] . $r['name'] . ($r['is_dir'] ? '/' : ''), $found['rows']);
        same_set($got, $want, "$label: search " . json_encode($text, JSON_UNESCAPED_UNICODE) . " in $scope");
        // a small page is the top of the full ranking (exact and prefix tiers, candidate windows)
        $all = $found['rows'];
        usort($all, [SearchEngine::class, 'cmp']);
        $page = $engine->search($scope, $query, $plan, 3, 1000000, microtime(true) + 30, true);
        check(array_column($page['rows'], 'id') === array_column(array_slice($all, 0, 3), 'id'),
            "$label: top 3 of " . json_encode($text, JSON_UNESCAPED_UNICODE) . " in $scope: " . json_encode(array_column($page['rows'], 'name'), JSON_UNESCAPED_UNICODE)
            . ' vs ' . json_encode(array_column(array_slice($all, 0, 3), 'name'), JSON_UNESCAPED_UNICODE)
            . (getenv('DEBUG') ? ' page ' . json_encode(array_map(fn ($r) => [$r['id'], $r['r'], $r['is_dir'], $r['kl'], $r['pl'], $r['key']], $page['rows']), JSON_UNESCAPED_UNICODE)
                . ' all ' . json_encode(array_map(fn ($r) => [$r['id'], $r['r'], $r['is_dir'], $r['kl'], $r['pl'], $r['key']], array_slice($all, 0, 4)), JSON_UNESCAPED_UNICODE)
                . ' truncated ' . json_encode($page['truncated']) : ''));
    }
}

echo "3/4. indexer and engine (seed $seed, $rounds rounds)\n";
make_tree($root, 0);
// fixtures for the special cases
mkdir($root . '/site');
file_put_contents($root . '/site/index.html', 'x');
file_put_contents($root . '/site/inside-unmanaged.txt', 'x');
mkdir($root . '/secretplace');
file_put_contents($root . '/secretplace/hidden-by-href.txt', 'x');
mkdir($root . '/nested/_h6ai/private/conf', 0777, true);
file_put_contents($root . '/nested/inside-nested.txt', 'x');
mkdir($root . '/locked');
file_put_contents($root . '/locked/unreadable-inside.txt', 'x');
chmod($root . '/locked', 0);
symlink($root . '/site', $root . '/link-to-site');
// another disk linked into the share: indexed through the link; its links back into the tree
// and to itself are not followed
$external = $base . '/external';
mkdir($external);
make_tree($external, 2);
file_put_contents($external . '/on-the-other-disk.txt', 'x');
symlink($root, $external . '/back-to-root');
symlink($external, $external . '/loop-to-itself');
symlink($external, $root . '/other-disk');

$indexer = new SearchIndexer($context, $index);
$r = $indexer->run(INF, 'auto', true);
check($r['did'] === 'build' && $r['done'], 'bulk build ' . json_encode($r));
$truth = reference($context, $root);
check(isset($truth['/site/']) && !isset($truth['/site/inside-unmanaged.txt']), 'reference: unmanaged folder listed, not descended');
check(!isset($truth['/secretplace/']), 'reference: hidden by href');
check(isset($truth['/locked/']) && !isset($truth['/locked/unreadable-inside.txt']), 'reference: unreadable folder listed, empty');
check(isset($truth['/other-disk/on-the-other-disk.txt']), 'reference: linked disk descended');
check(isset($truth['/other-disk/back-to-root/']) && !array_filter(array_keys($truth), fn ($k) => str_starts_with($k, '/other-disk/back-to-root/') && $k !== '/other-disk/back-to-root/'), 'reference: link back into the tree not descended');
check(isset($truth['/other-disk/loop-to-itself/']) && !array_filter(array_keys($truth), fn ($k) => str_starts_with($k, '/other-disk/loop-to-itself/') && $k !== '/other-disk/loop-to-itself/'), 'reference: loop not descended');
check(isset($truth['/link-to-site/']) && !isset($truth['/link-to-site/index.html']), 'reference: link into the tree not descended');
same_set(snapshot($index), array_keys($truth), 'bulk build == walk');
engine_check($index, $context, $root, $truth, 'after build');

$ops = ['add_file', 'add_file', 'rm_file', 'add_dir', 'rm_dir', 'rename_dir', 'move_dir', 'file_to_dir', 'unmanage', 'manage', 'chmod', 'unchmod', 'touch'];
for ($round = 1; $round <= $rounds; $round += 1) {
    $dirs = all_dirs($root);
    $done = [];
    for ($k = mt_rand(1, 6); $k > 0; $k -= 1) {
        // the linked disk changes too
        $dirs = array_merge(all_dirs($root), all_dirs($external));
        $dir = $dirs[mt_rand(0, count($dirs) - 1)];
        $op = $ops[mt_rand(0, count($ops) - 1)];
        $files = array_values(array_filter(array_map(fn ($n) => $dir . '/' . $n, @scandir($dir) ?: []), fn ($f) => is_file($f) && !is_link($f)));
        $subs = array_values(array_filter($dirs, fn ($d) => $d !== $root && dirname($d) === $dir));
        switch ($op) {
            case 'add_file': @file_put_contents($dir . '/' . rand_name(), 'x'); break;
            case 'rm_file': if ($files) { @unlink($files[array_rand($files)]); } break;
            case 'add_dir': $d = $dir . '/' . rand_name(); if (@mkdir($d)) { make_tree($d, 3); } break;
            case 'rm_dir': if ($subs) { exec('rm -rf ' . escapeshellarg($subs[array_rand($subs)])); } break;
            case 'rename_dir': if ($subs) { $s = $subs[array_rand($subs)]; @rename($s, dirname($s) . '/' . rand_name()); } break;
            case 'move_dir':
                if ($subs) {
                    $s = $subs[array_rand($subs)];
                    $target = $dirs[mt_rand(0, count($dirs) - 1)];
                    if (!str_starts_with($target . '/', $s . '/')) {
                        @rename($s, $target . '/' . rand_name());
                    }
                }
                break;
            case 'file_to_dir': if ($files) { $f = $files[array_rand($files)]; @unlink($f); @mkdir($f); @file_put_contents($f . '/was-a-file.txt', 'x'); } break;
            case 'unmanage': @file_put_contents($dir . '/index.html', 'x'); break;
            case 'manage': @unlink($dir . '/index.html'); break;
            case 'chmod': if ($subs) { @chmod($subs[array_rand($subs)], 0); } break;
            case 'unchmod': exec('chmod -R u+rwx ' . escapeshellarg($root) . ' ' . escapeshellarg($external) . ' 2>/dev/null'); @chmod($root . '/locked', 0); break;
            case 'touch': @touch($dir); break;
        }
        $done[] = $op;
    }
    clearstatcache(true);
    // same-second changes would be invisible to mtime/ctime: let a second pass, the way time does
    sleep(1);
    $context = ctx();
    $index = new SearchIndex($context);
    $sliced = $round % 3 === 0;
    $indexer = new SearchIndexer($context, $index);
    if ($sliced) {
        $steps = 0;
        do {
            $r = $indexer->run(0.02, 'refresh');
            $steps += 1;
        } while (!($r['done'] ?? true) && $steps < 100000);
    } else {
        $r = $indexer->run(INF, 'refresh', true);
    }
    $truth = reference($context, $root);
    same_set(snapshot($index), array_keys($truth), "round $round (" . implode(',', $done) . ($sliced ? ', sliced' : '') . ') one pass == walk');
    if (getenv('DEBUG')) {
        $rd = $index->open_reader($reason);
        foreach ($rd['db']->query("SELECT id, parent, name, is_dir, path, hi, mtime, ctime, fid, flags FROM node WHERE name LIKE '%link%' OR name LIKE '%site%' OR parent = 1 OR parent = -1") as $row) {
            echo '    ', json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
        }
        system('ls -la --time-style=+%s ' . escapeshellarg($root));
        echo '    log: ', implode(' | ', $GLOBALS['debug_log'] ?? []), "\n";
    }
    // folders changed in the second of the pass are re-checked by the next one
    $indexer->run(INF, 'refresh', true);
    same_set(snapshot($index), array_keys($truth), "round $round (" . implode(',', $done) . ($sliced ? ', sliced' : '') . ') refresh == walk');
    engine_check($index, $context, $root, $truth, "round $round");
    if ($round % 4 === 0) {
        // permission rules: a user who sees some folders only, and an anon account
        $dirs_rel = array_keys(array_filter($truth));
        if ($dirs_rel) {
            $rules = [];
            for ($k = 0; $k < 3; $k += 1) {
                $rules[] = ['path' => $dirs_rel[mt_rand(0, count($dirs_rel) - 1)], 'grants' => ['*' => ['none', 'list', 'download'][mt_rand(0, 2)], 'user:anon1' => 'list']];
            }
            engine_check($index, $context, $root, $truth, "round $round, rules", new Acl($rules, 'bob', []));
            engine_check($index, $context, $root, $truth, "round $round, anon " . json_encode($rules), new Acl($rules, 'anon1', [], true));
        }
    }
}

// a sliced full build gives the same index as a bulk one
$context = ctx();
$index = new SearchIndex($context);
$indexer = new SearchIndexer($context, $index);
$r = $indexer->run(0.01, 'rebuild');
for ($steps = 0; $r['did'] === 'build' && !$r['done'] && $steps < 100000; $steps += 1) {
    $r = $indexer->run(0.01, 'auto');
}
$truth = reference($context, $root);
same_set(snapshot($index), array_keys($truth), "sliced rebuild == walk ($steps slices)");
engine_check($index, $context, $root, $truth, 'after sliced rebuild');

// a configuration change makes the index stale (still used, re-checked) and triggers a rebuild
$local = json_decode(file_get_contents($root . '/_h6ai/private/conf/options.local.json'), true);
$local['view']['hidden'][] = '^notes';
file_put_contents($root . '/_h6ai/private/conf/options.local.json', json_encode($local));
touch($root . '/_h6ai/private/conf/options.local.json', time() + 5);
$context = ctx();
$index = new SearchIndex($context);
$reader = $index->open_reader($reason);
check($reader !== null && $reader['stale'], 'changed view.hidden: index stale but usable');
$r = (new SearchIndexer($context, $index))->run(INF, 'auto', true);
check($r['did'] === 'build', 'changed view.hidden: rebuilt');
$truth = reference($context, $root);
same_set(snapshot($index), array_keys($truth), 'after view.hidden change == walk');

// hideIf403 is applied live per result (Search::is_visible), whatever the index holds
$local['view']['hideIf403'] = true;
file_put_contents($root . '/_h6ai/private/conf/options.local.json', json_encode($local));
touch($root . '/_h6ai/private/conf/options.local.json', time() + 10);
$context = ctx();
$search = new Search($context);
$visible = (new ReflectionClass(Search::class))->getMethod('is_visible');
mkdir($root . '/open');
file_put_contents($root . '/open/f.txt', 'x');
check($visible->invoke($search, $root . '/open', 'f.txt', $root . '/open/f.txt', false), 'readable file visible');
chmod($root . '/open/f.txt', 0);
check(!$visible->invoke($search, $root . '/open', 'f.txt', $root . '/open/f.txt', false), 'unreadable file hidden');
check(!$visible->invoke($search, $root, 'locked', $root . '/locked', true), 'unreadable folder hidden');
mkdir($root . '/open/sub');
file_put_contents($root . '/open/sub/g.txt', 'x');
chmod($root . '/open/sub', 0100);
$search = new Search($context);
check(!$visible->invoke($search, $root . '/open/sub', 'g.txt', $root . '/open/sub/g.txt', false), 'file below an unreadable folder hidden');
check(!$visible->invoke($search, $root, 'secretplace', $root . '/secretplace', true), 'folder hidden by href pattern');
// (the random rounds may have changed /site: a fresh one)
mkdir($root . '/open/page');
file_put_contents($root . '/open/page/index.html', 'x');
file_put_contents($root . '/open/page/inside-unmanaged.txt', 'x');
$search = new Search($context);
check(!$visible->invoke($search, $root . '/open/page', 'inside-unmanaged.txt', $root . '/open/page/inside-unmanaged.txt', false), 'file in unmanaged folder hidden');
check(!$visible->invoke($search, $root . '/nested', 'inside-nested.txt', $root . '/nested/inside-nested.txt', false), 'file in nested install hidden');
check(!$visible->invoke($search, $root, '_h6ai', $root . '/_h6ai', true), 'the h6ai folder hidden');

// ---- 6. admission: search slots ---------------------------------------------------------------
// Search::acquire_slot in a child process (a busy answer exits): searches hold at most
// 2 x concurrency PHP workers, running or waiting. flock locks belong to open files, so this
// process can hold slots against the child.
echo "6. search slots\n";
$child = $base . '/slot-child.php';
file_put_contents($child, '<?php
define("H6AI_VERSION", "test");
define("MIN_PHP_VERSION", "8.2.0");
require_once $argv[1] . "/_h6ai/private/php/class-bootstrap.php";
spl_autoload_register([Bootstrap::class, "autoload"]);
$_SERVER += ["SCRIPT_NAME" => "/_h6ai/public/index.php", "REQUEST_METHOD" => "POST", "REQUEST_URI" => "/", "SERVER_SOFTWARE" => "nginx", "H6AI_SERVER_CONF" => "1"];
$search = new Search(new Context(new Session(false), Request::from_globals(), new Setup(false)));
$acquire = (new ReflectionClass(Search::class))->getMethod("acquire_slot");
$started = microtime(true);
register_shutdown_function(function () use ($started) { fwrite(STDERR, sprintf("%.3f", microtime(true) - $started)); });
echo is_resource($acquire->invoke($search)) ? "slot" : "none";
');
$slot_dir = $root . '/_h6ai/private/cache/search-slots';
@mkdir($slot_dir, 0700, true);
$hold = function (string $kind, int $n) use ($slot_dir): array {
    $fps = [];
    for ($i = 0; $i < $n; $i += 1) {
        $fp = fopen($slot_dir . '/' . $kind . '-' . $i . '.lock', 'c');
        flock($fp, LOCK_EX);
        $fps[] = $fp;
    }
    return $fps;
};
$release = function (array $fps): void {
    foreach ($fps as $fp) {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
};
$start_child = function () use ($child, $root): array {
    $proc = proc_open([PHP_BINARY, $child, $root], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    return [$proc, $pipes];
};
$finish_child = function (array $started): array {
    [$proc, $pipes] = $started;
    $out = stream_get_contents($pipes[1]);
    $seconds = (float) stream_get_contents($pipes[2]);
    proc_close($proc);
    return [str_contains($out, 'ERR_BUSY') ? 'busy' : $out, $seconds];
};
[$got, $s] = $finish_child($start_child());
check($got === 'slot' && $s < 0.1, "a free slot is taken at once ($got, $s s)");
$slots = $hold('slot', 4);
[$got, $s] = $finish_child($start_child());
check($got === 'busy' && $s >= 0.14, "all slots taken: waits 150 ms, then busy ($got, $s s)");
$waits = $hold('wait', 4);
[$got, $s] = $finish_child($start_child());
check($got === 'busy' && $s < 0.1, "all slots and wait slots taken: busy at once ($got, $s s)");
$release($waits);
$started_child = $start_child();
usleep(60000);
$release([array_pop($slots)]);
[$got, $s] = $finish_child($started_child);
check($got === 'slot', "a slot freed while waiting is taken ($got, $s s)");
$release($slots);

echo ($failures ? "FAILED: $failures of $checks checks\n" : "ok: $checks checks\n");
exit($failures ? 1 : 0);

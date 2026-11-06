<?php
// Benchmark tree for the search (docs/SEARCH.md, section 6): about N entries (default 1,000,000)
// of empty files in nested folders, with realistic names (camera dumps, releases, documents,
// unicode). Deterministic (seed 42). A million entries take about 2 minutes and 125 MB.
//   php gen-tree.php /target [entries]
$root = $argv[1] ?? '/bench';
$target = (int) ($argv[2] ?? 1000000);
mt_srand(42);
$words = ['project', 'report', 'final', 'draft', 'backup', 'invoice', 'photo', 'video', 'scan', 'notes', 'release',
    'ubuntu', 'debian', 'archive', 'budget', 'meeting', 'holiday', 'summer', 'winter', 'client', 'design', 'logo',
    'contract', 'manual', 'setup', 'driver', 'firmware', 'music', 'album', 'track', 'episode', 'season', 'movie',
    'data', 'export', 'import', 'config', 'server', 'linux', 'windows', 'kernel', 'source', 'build', 'test',
    'Ünïcödé', 'café', 'résumé', 'naïve', 'straße', '日本語', 'Ωμέγα', 'smörgåsbord', 'piñata', 'façade'];
$exts = ['.txt', '.pdf', '.jpg', '.jpeg', '.png', '.mp4', '.mkv', '.iso', '.zip', '.tar.gz', '.docx', '.xlsx', '.csv',
    '.log', '.json', '.mp3', '.flac', '.raw', '.cr2', '.mov', '.7z', '.deb', '.rpm', '.md', '.html', '.c', '.h', '.py'];
$word = fn () => $words[mt_rand(0, count($words) - 1)];
$name = function () use ($word, $exts) {
    switch (mt_rand(0, 5)) {
        case 0: return sprintf('IMG_%04d%02d%02d_%06d%s', mt_rand(2005, 2026), mt_rand(1, 12), mt_rand(1, 28), mt_rand(0, 999999), mt_rand(0, 1) ? '.jpg' : '.cr2');
        case 1: return sprintf('%s-%d.%d.%d%s', $word(), mt_rand(1, 24), mt_rand(0, 12), mt_rand(0, 9), $exts[mt_rand(0, count($exts) - 1)]);
        case 2: return sprintf('%s %s (%d)%s', ucfirst($word()), $word(), mt_rand(1, 9), $exts[mt_rand(0, count($exts) - 1)]);
        case 3: return sprintf('%s_%s_%04d%s', $word(), $word(), mt_rand(0, 9999), $exts[mt_rand(0, count($exts) - 1)]);
        case 4: return sprintf('S%02dE%02d %s %s.mkv', mt_rand(1, 12), mt_rand(1, 24), ucfirst($word()), $word());
        default: return $word() . mt_rand(0, 99999) . $exts[mt_rand(0, count($exts) - 1)];
    }
};
$count = 0;
$folders = 0;
$make = function (string $dir, int $depth) use (&$make, &$count, &$folders, $target, $word, $name) {
    // leaves hold most files; a few huge folders like camera dumps
    $files = $depth >= 3 ? mt_rand(5, 40) : mt_rand(0, 8);
    if (mt_rand(0, 400) === 0) {
        $files = mt_rand(2000, 8000);
    }
    for ($i = 0; $i < $files && $count < $target; $i += 1) {
        if (@touch($dir . '/' . $name())) {
            $count += 1;
        }
    }
    if ($depth >= 6) {
        return;
    }
    $subs = $depth < 2 ? mt_rand(8, 14) : mt_rand(0, 6);
    for ($i = 0; $i < $subs && $count < $target; $i += 1) {
        $sub = $dir . '/' . ($depth < 2 ? ucfirst($word()) . ' ' . (2000 + mt_rand(0, 26)) : $word() . '_' . mt_rand(1, 999));
        if (@mkdir($sub)) {
            $count += 1;
            $folders += 1;
            $make($sub, $depth + 1);
        }
    }
};
@mkdir($root, 0755, true);
$started = microtime(true);
$round = 0;
while ($count < $target) {
    $top = $root . '/share-' . $round++;
    mkdir($top);
    $folders += 1;
    $count += 1;
    $make($top, 1);
}
printf("%d entries (%d folders) in %.1f s\n", $count, $folders, microtime(true) - $started);

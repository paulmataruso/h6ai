<?php
declare(strict_types=1);

// Checks from the admin page that nginx hands requests for every type of file to h6ai. A regex
// location of the server block's own, typically a caching rule such as
// `location ~* \.(jpg|css|js)$ { expires 30d; }`, wins over h6ai's `location /`: files of those
// types then go out without the permission check (or, on drop-in installs, never reach h6ai).
//
// The admin page starts a probe (a short-lived random token), requests
// <root>/h6ai-probe-<token>.<ext> for each extension below (no such files exist) and then asks
// which of them arrived: the gate (nginx's auth_request) and the drop-in file server note every
// probe request before they answer it. A request nginx answered on its own never shows up.
final class GateProbe {
    public const EXTS = [
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif',
        'css', 'js', 'mjs', 'json', 'map', 'txt', 'md', 'csv', 'log', 'html', 'htm', 'xml',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'odt', 'epub',
        'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'mp3', 'm4a', 'flac', 'ogg', 'wav',
        'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'iso', 'img', 'dmg',
        'exe', 'msi', 'deb', 'rpm', 'apk', 'bin', 'woff', 'woff2', 'ttf', 'otf', 'eot',
        'php', 'py', 'sh', 'cgi', 'pl'
    ];
    private const FILE = 'gate-probe.php';
    private const TTL = 120;
    private const PREFIX = 'h6ai-probe-';

    private static function file(Context $context): string {
        return $context->get_setup()->get('CACHE_PRV_PATH') . '/' . GateProbe::FILE;
    }

    // A new token for the admin page; replaces a probe that may still be running. On drop-in
    // installs also the probe link (see FileServer::probe), so the page can check that nginx
    // refuses it from outside.
    public static function start(Context $context): array {
        $setup = $context->get_setup();
        $token = bin2hex(random_bytes(16));
        return [
            'ok' => Json::write_guarded(GateProbe::file($context), $token . ' ' . time() . "\n"),
            'href' => $setup->get('ROOT_HREF') . GateProbe::PREFIX . $token . '.',
            'exts' => GateProbe::EXTS,
            'link' => $setup->get('IS_DROPIN') ? FileServer::probe_href($context, 'txt') : null
        ];
    }

    // Sees every request the gate or the drop-in file server handles. True for a probe request,
    // which the caller then answers right away; noted only while its token is current.
    public static function note(Context $context, string $decoded): bool {
        $prefix = $context->get_setup()->get('ROOT_HREF') . GateProbe::PREFIX;
        if (!str_starts_with($decoded, $prefix)
            || preg_match('/^([0-9a-f]{32})\.([a-z0-9]{1,8})$/', substr($decoded, strlen($prefix)), $m) !== 1) {
            return false;
        }
        $file = GateProbe::file($context);
        $head = explode(' ', trim(explode("\n", Json::unguard((string) @file_get_contents($file, false, null, 0, 512)))[0] ?? ''));
        if (count($head) === 2 && hash_equals($head[0], $m[1]) && time() - (int) $head[1] <= GateProbe::TTL
            && in_array($m[2], GateProbe::EXTS, true)) {
            @file_put_contents($file, $m[2] . "\n", FILE_APPEND | LOCK_EX);
        }
        return true;
    }

    // The extensions that arrived since start(); ends the probe.
    public static function result(Context $context): array {
        $file = GateProbe::file($context);
        $lines = array_slice(explode("\n", Json::unguard((string) @file_get_contents($file))), 1);
        @unlink($file);
        return ['seen' => array_values(array_unique(array_intersect($lines, GateProbe::EXTS)))];
    }
}

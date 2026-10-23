<?php
declare(strict_types=1);

// Drop-in installs: h6ai serves the shared folder itself. The folder lives outside the web root,
// and one nginx line (error_page 403 404 = /_h6ai/public/index.php) hands every request nginx
// can't answer to h6ai. So each file request passes the checks nginx's auth_request gate makes in
// a full install: permissions, the download log, the sandbox for active documents.
//
// The bytes: active documents (HTML, SVG, XML) are sent by PHP with the sandbox CSP. Everything
// else goes back to nginx through X-Accel-Redirect to a secret link into the shared folder
// (sendfile, Range, ETag, no PHP worker held) once the admin page has seen that work. Until then,
// or where it doesn't, PHP streams the file itself (Range, ETag, 304).
final class FileServer {
    // the same list as deploy/nginx/server.conf
    private const ACTIVE_RE = '/\.(?:html?|xhtml|shtml|svgz?|xml|xslt?|mht|mhtml)$/i';
    // Never handed to nginx: after X-Accel-Redirect the server's own locations apply, and its
    // "location ~ \.php$" would run a PHP file from the share instead of sending it. PHP sends
    // these as plain data.
    private const SCRIPT_RE = '/\.(?:php\d?|phtml|pht|phar|phps|inc|pl|pm|py|rb|cgi|fcgi|sh|asp|aspx|jsp|cfm)(?:\.|$)/i';
    private const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:";
    private const CHUNK = 1048576;
    // Smaller files go out through PHP with all headers (nosniff included: nginx drops it after
    // X-Accel-Redirect); they take a moment. The big ones, where a held PHP worker would hurt, are
    // media, archives and images of disks, which browsers don't sniff into anything dangerous.
    private const ACCEL_MIN_SIZE = 4194304;
    private const PROBE = "h6ai-xaccel-ok\n";
    // charset like nginx's "charset utf-8" (charset_types)
    private const TEXT_TYPES = ['text/html', 'text/plain', 'text/xml', 'text/css', 'application/javascript', 'application/xml'];
    private const MIME = [
        'html' => 'text/html', 'htm' => 'text/html', 'shtml' => 'text/html', 'xhtml' => 'application/xhtml+xml',
        'txt' => 'text/plain', 'css' => 'text/css', 'js' => 'application/javascript', 'mjs' => 'application/javascript',
        'json' => 'application/json', 'xml' => 'text/xml', 'xsl' => 'application/xml', 'xslt' => 'application/xml',
        'svg' => 'image/svg+xml', 'svgz' => 'image/svg+xml', 'mht' => 'message/rfc822', 'mhtml' => 'message/rfc822',
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp',
        'avif' => 'image/avif', 'ico' => 'image/x-icon', 'bmp' => 'image/x-ms-bmp', 'tif' => 'image/tiff', 'tiff' => 'image/tiff',
        'pdf' => 'application/pdf', 'zip' => 'application/zip', 'gz' => 'application/gzip', 'tar' => 'application/x-tar',
        '7z' => 'application/x-7z-compressed', 'rar' => 'application/x-rar-compressed', 'iso' => 'application/octet-stream',
        'mp4' => 'video/mp4', 'm4v' => 'video/x-m4v', 'webm' => 'video/webm', 'mkv' => 'video/x-matroska', 'mov' => 'video/quicktime',
        'avi' => 'video/x-msvideo', 'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'oga' => 'audio/ogg', 'opus' => 'audio/ogg',
        'wav' => 'audio/wav', 'flac' => 'audio/flac', 'm4a' => 'audio/x-m4a', 'aac' => 'audio/aac',
        'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf', 'otf' => 'font/otf',
        'csv' => 'text/csv', 'rtf' => 'application/rtf', 'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ];

    public function __construct(private readonly Context $context) {}

    // For a request that isn't an h6ai page or API call: sends a file, a folder's own index page,
    // a redirect or a 404. Returns only for folder URLs, which the caller renders as the listing.
    public function route(): void {
        $setup = $this->context->get_setup();
        $href = (string) $setup->get('REQUEST_HREF');
        $decoded = rawurldecode($href);
        // h6ai's own folders (nginx refused to list them and handed over the 403)
        if (Util::starts_with(Util::normalize_path($decoded, true), (string) $setup->get('H6AI_HREF'))) {
            $this->not_found();
        }
        $path = $this->context->decoded_to_path($decoded);
        if ($path === null) {
            $this->not_found();
        }
        if (is_dir($path)) {
            if (!str_ends_with($decoded, '/')) {
                $query = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_QUERY);
                header('Location: ' . $href . '/' . ($query !== '' ? '?' . $query : ''), true, 301);
                exit;
            }
            // a folder with its own index page shows that page, like nginx's index directive
            foreach (['index.html', 'index.htm'] as $index) {
                if (is_file($path . '/' . $index)) {
                    $this->send($path . '/' . $index);
                }
            }
            return;
        }
        if (is_file($path)) {
            $this->send($path);
        }
        $this->not_found();
    }

    private function not_found(): never {
        http_response_code(404);
        // lets the admin page see that nginx hands unknown paths to h6ai (error_page)
        header('X-H6ai-Route: not-found');
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-cache');
        $root = Util::html((string) $this->context->get_setup()->get('ROOT_HREF'));
        echo "<!DOCTYPE html>\n<title>Not found</title>\n<p>Nothing here. <a href=\"{$root}\">Back to the files</a></p>\n";
        exit;
    }

    private function deny(): never {
        // 401 invites a login; in anonymous mode there is none to offer
        $status = $this->context->get_user() === null && !$this->context->is_anonymous_mode() ? 401 : 403;
        http_response_code($status);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: private, no-cache');
        echo $status === 401 ? "Log in to open this file.\n" : "You don't have access to this file.\n";
        exit;
    }

    private function send(string $file): never {
        $dir = Util::normalize_path(dirname($file));
        $public = true;
        if ($this->context->get_acl()->is_enabled()) {
            if (!$this->context->can($dir, Acl::READ)) {
                $this->deny();
            }
            $rules = $this->context->get_auth_store()->get_effective_rules();
            $public = Acl::is_public($rules, $this->context->to_rel_path($dir));
        }
        $cache_control = $public ? 'public, no-cache' : 'private, no-cache';
        // a download can take hours: don't hold the session lock meanwhile
        $this->context->get_session()->close();

        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $log = Gate::is_download_start($this->context, $method);
        if (preg_match(FileServer::ACTIVE_RE, $file) !== 1 && preg_match(FileServer::SCRIPT_RE, basename($file)) !== 1
            && (int) @filesize($file) >= FileServer::ACCEL_MIN_SIZE
            && $this->context->get_settings()->get('dropin.fastDownloads') === true) {
            $target = $this->accel_href($file);
            if ($target !== null) {
                // nginx sends the file and picks the Content-Type; keeps Cache-Control from here
                ini_set('default_mimetype', '');
                header('X-Accel-Redirect: ' . $target);
                header('Cache-Control: ' . $cache_control);
                if ($log) {
                    if (function_exists('fastcgi_finish_request')) {
                        fastcgi_finish_request();
                    }
                    Gate::record_download($this->context, $file);
                }
                exit;
            }
        }
        if ($log) {
            Gate::record_download($this->context, $file);
        }
        $this->stream($file, $cache_control, $method === 'HEAD');
    }

    // "/_h6ai/private/cache/xs-<secret>/<path in the shared folder>", or null without the link.
    // The link's name derives from the install's secret: it's never sent to a browser, and
    // nginx doesn't list the folder it's in.
    private function accel_href(string $file): ?string {
        $setup = $this->context->get_setup();
        $name = 'xs-' . substr(hash_hmac('sha256', 'files-link', $this->context->get_secret()), 0, 40);
        $link = $setup->get('CACHE_PRV_PATH') . '/' . $name;
        $root = (string) $setup->get('ROOT_PATH');
        if (!FileServer::ensure_link($link, $root)) {
            return null;
        }
        $parts = array_map('rawurlencode', array_filter(explode('/', substr($file, strlen($root))), fn ($p) => $p !== ''));
        return $setup->get('H6AI_HREF') . 'private/cache/' . $name . '/' . implode('/', $parts);
    }

    // Links live in private/cache; its index.php (404) keeps nginx from listing their secret
    // names even with autoindex on, as long as the server's index lists index.php.
    private static function ensure_link(string $link, string $target): bool {
        $dir = dirname($link);
        if (!is_file($dir . '/index.php')) {
            @file_put_contents($dir . '/index.php', Json::GUARD);
        }
        if (is_link($link) && readlink($link) === $target) {
            return true;
        }
        @unlink($link);
        return @symlink($target, $link);
    }

    // The admin page asks for this once: if the probe text arrives, nginx follows X-Accel-Redirect
    // through a link in private/cache, and fast downloads can be switched on.
    public function probe(): never {
        $setup = $this->context->get_setup();
        $cache = (string) $setup->get('CACHE_PRV_PATH');
        $dir = $cache . '/probe';
        $name = 'xp-' . substr(hash_hmac('sha256', 'probe-link', $this->context->get_secret()), 0, 40);
        header('Cache-Control: no-store');
        if ((!is_dir($dir) && !@mkdir($dir, 0755)) || (!is_file($dir . '/probe.txt') && @file_put_contents($dir . '/probe.txt', FileServer::PROBE) === false)
            || !FileServer::ensure_link($cache . '/' . $name, $dir)) {
            header('Content-Type: text/plain');
            echo "no link\n";
            exit;
        }
        ini_set('default_mimetype', '');
        header('X-Accel-Redirect: ' . $setup->get('H6AI_HREF') . 'private/cache/' . $name . '/probe.txt');
        exit;
    }

    // h6ai's own static files on drop-in installs: /_h6ai/public/v/<tag>/<path> (no such file, so
    // nginx hands it over) is public/<path>, sent the way h6ai's nginx snippet sends public/:
    // cacheable for a year (the tag changes with the version, thumbnails with their mtime), text
    // types gzipped.
    public function asset(): never {
        $setup = $this->context->get_setup();
        $rel = substr(rawurldecode((string) $setup->get('REQUEST_HREF')), strlen((string) $setup->get('PUBLIC_HREF') . 'v/'));
        $parts = explode('/', $rel);
        array_shift($parts); // the tag
        foreach ($parts as $part) {
            if ($part === '' || $part[0] === '.' || str_contains($part, "\0")) {
                $this->not_found();
            }
        }
        $file = $setup->get('PUBLIC_PATH') . '/' . implode('/', $parts);
        if (!$parts || !is_file($file) || preg_match('/\.php$/i', $file) === 1) {
            $this->not_found();
        }
        $type = FileServer::mime($file);
        $etag = sprintf('"%x-%x"', (int) @filemtime($file), (int) @filesize($file));
        header('Content-Type: ' . $type);
        header('Cache-Control: public, max-age=31536000, immutable');
        header('X-Content-Type-Options: nosniff');
        header('ETag: ' . $etag);
        header('Vary: Accept-Encoding');
        if (trim((string) $this->context->get_request()->header('If-None-Match')) === $etag) {
            http_response_code(304);
            exit;
        }
        $body = (string) file_get_contents($file);
        $gzip = preg_match('/^(text\/|application\/(javascript|json|xml)|image\/svg)/', $type) === 1 && strlen($body) >= 1024
            && str_contains((string) $this->context->get_request()->header('Accept-Encoding'), 'gzip');
        if ($gzip) {
            $body = (string) gzencode($body, 6);
            header('Content-Encoding: gzip');
        }
        header('Content-Length: ' . strlen($body));
        if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'HEAD') {
            echo $body;
        }
        exit;
    }

    private static function mime(string $file): string {
        $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        $type = FileServer::MIME[$ext] ?? 'application/octet-stream';
        return in_array($type, FileServer::TEXT_TYPES, true) ? $type . '; charset=utf-8' : $type;
    }

    // PHP sends the file: Range (one range), If-Range, ETag/Last-Modified with 304.
    private function stream(string $file, string $cache_control, bool $head): never {
        $size = (int) @filesize($file);
        $mtime = (int) @filemtime($file);
        $etag = sprintf('"%x-%x"', $mtime, $size); // nginx's format
        $request = $this->context->get_request();

        header('Content-Type: ' . FileServer::mime($file));
        header('Accept-Ranges: bytes');
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
        header('ETag: ' . $etag);
        header('Cache-Control: ' . $cache_control);
        header('X-Content-Type-Options: nosniff');
        // nginx relays the stream as it comes instead of spooling it to a temp file
        header('X-Accel-Buffering: no');
        if (preg_match(FileServer::ACTIVE_RE, $file) === 1) {
            header('Content-Security-Policy: ' . FileServer::SANDBOX_CSP);
        }

        $none_match = $request->header('If-None-Match');
        $modified_since = $request->header('If-Modified-Since');
        if ($none_match !== null
            ? (trim($none_match) === '*' || in_array($etag, array_map(fn ($t) => preg_replace('/^W\//', '', trim($t)), explode(',', $none_match)), true))
            : ($modified_since !== null && ($since = strtotime($modified_since)) !== false && $since >= $mtime)) {
            http_response_code(304);
            exit;
        }

        $start = 0;
        $end = $size - 1;
        $range = $request->header('Range');
        $if_range = $request->header('If-Range');
        $range_applies = $range !== null && $size > 0
            && ($if_range === null || trim($if_range) === $etag || strtotime($if_range) === $mtime);
        if ($range_applies && preg_match('/^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i', $range, $m) && ($m[1] !== '' || $m[2] !== '')) {
            if ($m[1] === '') {
                $start = max(0, $size - (int) $m[2]);
            } else {
                $start = (int) $m[1];
                $end = $m[2] === '' ? $size - 1 : min((int) $m[2], $size - 1);
            }
            if ($start > $end || $start >= $size || ($m[1] === '' && (int) $m[2] === 0)) {
                http_response_code(416);
                header('Content-Range: bytes */' . $size);
                header('Content-Length: 0');
                exit;
            }
            http_response_code(206);
            header("Content-Range: bytes $start-$end/$size");
        } else {
            http_response_code(200);
        }
        $length = $size > 0 ? $end - $start + 1 : 0;

        // text gets gzipped like h6ai's nginx snippet does it (gzip_types): whole responses only,
        // with a weak ETag; files this small are cheap to compress
        $type = FileServer::mime($file);
        if (http_response_code() === 200 && $length >= 1024 && $length < FileServer::ACCEL_MIN_SIZE
            && preg_match('/^(text\/|application\/(javascript|json|xml)|image\/svg)/', $type) === 1
            && str_contains((string) $request->header('Accept-Encoding'), 'gzip')) {
            header('Vary: Accept-Encoding');
            header('ETag: W/' . $etag);
            header('Content-Encoding: gzip');
            $body = (string) gzencode((string) file_get_contents($file), 5);
            header('Content-Length: ' . strlen($body));
            if (!$head) {
                echo $body;
            }
            exit;
        }

        header('Content-Length: ' . $length);
        if ($head || $length === 0) {
            exit;
        }

        set_time_limit(0);
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        $fp = @fopen($file, 'rb');
        if ($fp === false) {
            exit;
        }
        fseek($fp, $start);
        $left = $length;
        while ($left > 0 && !feof($fp) && connection_status() === CONNECTION_NORMAL) {
            $chunk = fread($fp, min(FileServer::CHUNK, $left));
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
            flush();
            $left -= strlen($chunk);
        }
        fclose($fp);
        exit;
    }
}

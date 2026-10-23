<?php
declare(strict_types=1);

final class Json {
    // Data in private/ may sit in a web root that the server hands out as is (drop-in installs).
    // It's stored in .php files that answer 404 and stop when a request runs them; the data follows
    // the first line. Without a PHP handler they'd be sent as text, which the admin page checks.
    public const GUARD = "<?php http_response_code(404); exit; ?>\n";

    public static function unguard(string $raw): string {
        if (!str_starts_with($raw, '<?php')) {
            return $raw;
        }
        $newline = strpos($raw, "\n");
        return $newline === false ? '' : substr($raw, $newline + 1);
    }

    // Writes $content behind the guard line, atomically (temp file + rename), readable by PHP only.
    public static function write_guarded(string $path, string $content): bool {
        $tmp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
        if (@file_put_contents($tmp, Json::GUARD . $content) === false) {
            @unlink($tmp);
            return false;
        }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            return false;
        }
        return true;
    }

    // Returns [] for missing/unreadable files and null if the content is not valid JSON.
    // Guarded files (see GUARD) are read the same way.
    public static function load(string $path): ?array {
        if (!is_file($path) || !is_readable($path)) {
            return [];
        }

        $json = file_get_contents($path);
        if ($json === false) {
            return [];
        }
        $data = json_decode(Json::strip(Json::unguard($json)), true);
        return is_array($data) ? $data : null;
    }

    // Like load(), but keeps a compiled copy (a PHP file returning the array) in $cache_dir so
    // OPcache can serve it without re-parsing. The copy records the source mtime and size and is
    // ignored as soon as they differ.
    public static function load_cached(string $path, string $cache_dir): ?array {
        $mtime = @filemtime($path);
        $size = @filesize($path);
        if ($mtime === false || $size === false) {
            return [];
        }

        $cache_file = $cache_dir . '/json-' . sha1($path) . '.php';
        $cached = is_file($cache_file) ? @include $cache_file : null;
        // mtime has a resolution of one second: a copy made in the same second the file was written
        // can't tell a second write of the same size apart, so only copies made later are trusted
        if (is_array($cached) && ($cached['m'] ?? null) === $mtime && ($cached['s'] ?? null) === $size
            && ($cached['c'] ?? 0) > $mtime) {
            return $cached['d'];
        }

        $data = Json::load($path);
        if ($data !== null && is_dir($cache_dir) && is_writable($cache_dir)) {
            $code = '<?php return ' . var_export(['m' => $mtime, 's' => $size, 'c' => time(), 'd' => $data], true) . ';';
            $tmp = $cache_file . '.' . bin2hex(random_bytes(4)) . '.tmp';
            if (@file_put_contents($tmp, $code) !== false && @rename($tmp, $cache_file)) {
                if (function_exists('opcache_invalidate')) {
                    @opcache_invalidate($cache_file, true);
                }
            } else {
                @unlink($tmp);
            }
        }
        return $data;
    }

    public static function save(string $path, mixed $obj): bool {
        $json = json_encode($obj);
        return $json !== false && @file_put_contents($path, $json, LOCK_EX) !== false;
    }

    // Removes // and /* */ comments outside of strings.
    public static function strip(string $commented_json): string {
        $json = '';
        $in_string = false;
        $len = strlen($commented_json);

        for ($i = 0; $i < $len; $i += 1) {
            $char = $commented_json[$i];
            $next = $i + 1 < $len ? $commented_json[$i + 1] : '';

            if ($in_string) {
                $json .= $char;
                if ($char === '\\') {
                    $json .= $next;
                    $i += 1;
                } elseif ($char === '"') {
                    $in_string = false;
                }
            } elseif ($char === '"') {
                $in_string = true;
                $json .= $char;
            } elseif ($char === '/' && $next === '/') {
                $end = strpos($commented_json, "\n", $i);
                $i = ($end === false ? $len : $end) - 1;
            } elseif ($char === '/' && $next === '*') {
                $end = strpos($commented_json, '*/', $i + 2);
                $i = ($end === false ? $len : $end + 2) - 1;
            } else {
                $json .= $char;
            }
        }

        return $json;
    }
}

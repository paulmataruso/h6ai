<?php
declare(strict_types=1);

final class Json {
    // Returns [] for missing/unreadable files and null if the content is not valid JSON.
    public static function load(string $path): ?array {
        if (!is_file($path) || !is_readable($path)) {
            return [];
        }

        $json = file_get_contents($path);
        if ($json === false) {
            return [];
        }
        $data = json_decode(Json::strip($json), true);
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
        if (is_array($cached) && ($cached['m'] ?? null) === $mtime && ($cached['s'] ?? null) === $size) {
            return $cached['d'];
        }

        $data = Json::load($path);
        if ($data !== null && is_dir($cache_dir) && is_writable($cache_dir)) {
            $code = '<?php return ' . var_export(['m' => $mtime, 's' => $size, 'd' => $data], true) . ';';
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

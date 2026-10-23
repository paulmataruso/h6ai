<?php
declare(strict_types=1);

final class Util {
    public const ERR_MISSING_PARAM = 'ERR_MISSING_PARAM';
    public const ERR_ILLEGAL_PARAM = 'ERR_ILLEGAL_PARAM';
    public const ERR_FAILED = 'ERR_FAILED';
    public const ERR_DISABLED = 'ERR_DISABLED';
    public const ERR_UNSUPPORTED = 'ERR_UNSUPPORTED';
    public const ERR_FORBIDDEN = 'ERR_FORBIDDEN';
    public const ERR_RATE_LIMITED = 'ERR_RATE_LIMITED';
    public const ERR_TOO_EARLY = 'ERR_TOO_EARLY';
    public const NO_DEFAULT = 'NO_*@+#?!_DEFAULT';
    public const RE_DELIMITER = '@';

    private const ERR_STATUS = [
        self::ERR_MISSING_PARAM => 400,
        self::ERR_ILLEGAL_PARAM => 400,
        self::ERR_UNSUPPORTED => 400,
        self::ERR_DISABLED => 403,
        self::ERR_FORBIDDEN => 403,
        self::ERR_RATE_LIMITED => 429,
        self::ERR_TOO_EARLY => 425,
        self::ERR_FAILED => 500
    ];

    public static function normalize_path(string $path, bool $trailing_slash = false): string {
        $path = preg_replace('#[\\\\/]+#', '/', $path);
        return preg_match('#^(\w:)?/$#', $path) ? $path : (rtrim($path, '/') . ($trailing_slash ? '/' : ''));
    }

    public static function json_exit(mixed $obj = [], int $status = 200): never {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json;charset=utf-8');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
        }
        echo json_encode($obj, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
        exit;
    }

    public static function json_fail(string $err, string $msg = '', bool $cond = true): void {
        if ($cond) {
            Util::json_exit(['err' => $err, 'msg' => $msg], self::ERR_STATUS[$err] ?? 400);
        }
    }

    public static function array_query(mixed $array, string $keypath = '', mixed $default = Util::NO_DEFAULT): mixed {
        $value = $array;

        $keys = array_filter(explode('.', $keypath), fn ($key) => $key !== '');
        foreach ($keys as $key) {
            if (!is_array($value) || !array_key_exists($key, $value)) {
                return $default;
            }
            $value = $value[$key];
        }

        return $value;
    }

    // Recursively merges $override into $base. Lists (sequential arrays) are replaced, not merged.
    public static function array_merge_deep(array $base, array $override): array {
        foreach ($override as $key => $value) {
            if (is_array($value) && isset($base[$key]) && is_array($base[$key]) && !array_is_list($value)) {
                $base[$key] = Util::array_merge_deep($base[$key], $value);
            } else {
                $base[$key] = $value;
            }
        }
        return $base;
    }

    public static function starts_with(string $sequence, string $head): bool {
        return str_starts_with($sequence, $head);
    }

    public static function ends_with(string $sequence, string $tail): bool {
        return str_ends_with($sequence, $tail);
    }

    // Wraps a user or config supplied pattern in delimiters. Raw delimiter chars are replaced by
    // their hex escape, so no input can terminate the pattern early and append modifiers.
    public static function wrap_pattern(string $pattern): string {
        $escaped = str_replace(Util::RE_DELIMITER, '\\x' . bin2hex(Util::RE_DELIMITER), $pattern);
        return Util::RE_DELIMITER . $escaped . Util::RE_DELIMITER;
    }

    public static function html(mixed $value): string {
        return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }

    // Validates an integer-like request value. Returns null if invalid or out of range.
    public static function to_int(mixed $value, int $min, int $max): ?int {
        if (is_int($value)) {
            $int = $value;
        } elseif (is_float($value) && floor($value) === $value) {
            $int = (int) $value;
        } elseif (is_string($value) && preg_match('/^\d{1,9}$/', $value)) {
            $int = (int) $value;
        } else {
            return null;
        }
        return ($int >= $min && $int <= $max) ? $int : null;
    }

    // Runs a command given as argv array (no shell involved). Returns [exit code, stdout].
    public static function exec_argv(array $argv, ?string $cwd = null): array {
        $descriptors = [
            0 => ['file', '/dev/null', 'r'],
            1 => ['pipe', 'w'],
            2 => ['file', '/dev/null', 'w']
        ];
        $proc = @proc_open(array_map('strval', $argv), $descriptors, $pipes, $cwd);
        if (!is_resource($proc)) {
            return [-1, ''];
        }
        $out = stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        $rc = proc_close($proc);
        return [$rc, $out === false ? '' : $out];
    }

    // Prefixes argv with `timeout <seconds>` if available, to bound runaway subprocesses.
    public static function with_timeout(Setup $setup, array $argv, int $seconds): array {
        if ($setup->get('HAS_CMD_TIMEOUT')) {
            return array_merge(['timeout', '--kill-after=5', (string) $seconds], $argv);
        }
        return $argv;
    }

    public static function exec_0(string $cmd): bool {
        $lines = [];
        $rc = null;
        try {
            @exec($cmd . ' 2>/dev/null', $lines, $rc);
            return $rc === 0;
        } catch (Throwable $e) {
            return false;
        }
    }

    public static function filesize(Context $context, string $path): ?int {
        $with_foldersize = $context->query_option('foldersize.enabled', false) === true;
        $with_du = $context->get_setup()->get('HAS_CMD_DU') && $context->query_option('foldersize.type', null) === 'shell-du';
        return Filesize::getCachedSize($context, $path, $with_foldersize, $with_du);
    }
}

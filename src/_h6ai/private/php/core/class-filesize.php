<?php
declare(strict_types=1);

final class Filesize {
    private const MAX_DEPTH = 64;

    private static array $cache = [];

    private const DEFAULT_CACHE_TTL = 600;

    public static function getCachedSize(Context $context, string $path, bool $with_foldersize, bool $with_du): ?int {
        if (array_key_exists($path, Filesize::$cache)) {
            return Filesize::$cache[$path];
        }

        if ($with_foldersize && is_dir($path)) {
            $size = Filesize::get_persistent($context, $path, $with_du);
        } else {
            $size = (new Filesize($context))->size($path, $with_foldersize, $with_du);
        }

        Filesize::$cache[$path] = $size;
        return $size;
    }

    // Recursive folder sizes are expensive on big trees. They are cached in the private cache
    // for foldersize.cacheTtl seconds (0 disables the persistent cache).
    private static function get_persistent(Context $context, string $path, bool $with_du): ?int {
        $ttl = (int) $context->query_option('foldersize.cacheTtl', Filesize::DEFAULT_CACHE_TTL);
        $dir = $context->get_setup()->get('CACHE_PRV_PATH') . '/foldersize';
        $file = $dir . '/' . sha1($path . '|' . ($with_du ? 'du' : 'php')) . '.json';

        if ($ttl > 0) {
            $mtime = @filemtime($file);
            if ($mtime !== false && $mtime > time() - $ttl) {
                $cached = @file_get_contents($file);
                if (is_string($cached) && preg_match('/^\d+$/', $cached)) {
                    return (int) $cached;
                }
            }
        }

        $size = (new Filesize($context))->size($path, true, $with_du);

        if ($ttl > 0 && $size !== null && $context->get_setup()->get('HAS_WRITABLE_CACHE_PRV')) {
            if (!is_dir($dir)) {
                @mkdir($dir, 0700, true);
            }
            $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
            if (@file_put_contents($tmp, (string) $size) === false || !@rename($tmp, $file)) {
                @unlink($tmp);
            }
        }
        return $size;
    }

    private function __construct(private readonly Context $context) {}

    // Sums file sizes below $path. Symlinked directories are not descended into, which
    // prevents endless recursion on symlink cycles.
    private function php_filesize(string $path, int $depth = 0): int {
        if (is_file($path)) {
            $size = @filesize($path);
            return $size === false ? 0 : $size;
        }
        if ($depth > Filesize::MAX_DEPTH || ($depth > 0 && is_link($path)) || !is_dir($path)) {
            return 0;
        }
        $names = @scandir($path);
        if ($names === false) {
            return 0;
        }
        $size = 0;
        foreach ($names as $name) {
            if ($name !== '.' && $name !== '..') {
                $size += $this->php_filesize($path . '/' . $name, $depth + 1);
            }
        }
        return $size;
    }

    private function exec_du(string $path): ?int {
        $argv = Util::with_timeout($this->context->get_setup(), ['du', '-sbL', '--', $path], 30);
        [$rc, $out] = Util::exec_argv($argv);
        if (preg_match('/^(\d+)\s/', $out, $matches)) {
            return (int) $matches[1];
        }
        return null;
    }

    private function size(string $path, bool $with_foldersize, bool $with_du): ?int {
        if (is_file($path)) {
            $size = @filesize($path);
            return $size === false ? null : $size;
        }

        if ($with_foldersize && is_dir($path)) {
            return $with_du ? $this->exec_du($path) : $this->php_filesize($path);
        }

        return null;
    }
}

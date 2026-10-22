<?php
declare(strict_types=1);

final class Archive {
    private const NUL = "\0";
    private const BLOCK = 512;
    private const SEGMENT_SIZE = 4194304; // 4 MiB
    private const USTAR_MAX_SIZE = 8589934591; // 0o77777777777
    private const TYPES = ['php-tar', 'shell-tar', 'shell-zip'];

    private const DEFAULT_MAX_ENTRIES = 200000;

    private string $type = 'php-tar';
    private string $base_path = '';
    // list of [real path, archived name, is dir]; archived names are relative to base_path
    private array $entries = [];
    private array $visited = [];

    public function __construct(private readonly Context $context) {}

    // Validates the request and collects the entries. Returns an error message or null.
    public function prepare(string $type, mixed $base_href, mixed $hrefs): ?string {
        $setup = $this->context->get_setup();
        if (!in_array($type, Archive::TYPES, true)) {
            return 'unsupported archive type';
        }
        if ($type === 'shell-tar' && !$setup->get('HAS_CMD_TAR')) {
            return 'tar not available';
        }
        if ($type === 'shell-zip' && !$setup->get('HAS_CMD_ZIP')) {
            return 'zip not available';
        }
        $this->type = $type;

        $base_path = $this->context->to_path($base_href);
        if ($base_path === null || !$this->context->is_managed_path($base_path)) {
            return 'invalid baseHref';
        }
        $this->base_path = $base_path;

        if (is_string($hrefs)) {
            $hrefs = [$hrefs];
        }
        if (!is_array($hrefs)) {
            return 'invalid hrefs';
        }
        $hrefs = array_filter($hrefs, fn ($href) => !(is_string($href) && trim($href) === ''));

        if (!$hrefs) {
            $this->add_dir_content($this->base_path, '');
            return $this->check_size();
        }

        foreach ($hrefs as $href) {
            $path = $this->context->to_path($href);
            if ($path === null || !Util::starts_with($path, $this->base_path === '/' ? '/' : $this->base_path . '/') || $path === $this->base_path) {
                return 'href outside of baseHref';
            }
            $name = ltrim(substr($path, strlen($this->base_path)), '/');

            if (is_dir($path) && $this->context->is_managed_path($path) && $this->context->can($path, Acl::DOWNLOAD)) {
                $this->add_dir($path, $name);
            } elseif ($this->context->is_exposed_file($path, Acl::DOWNLOAD) && is_readable($path)) {
                $this->entries[] = [$path, $name, false];
            } else {
                return 'href not available';
            }
        }

        return $this->check_size();
    }

    private function check_size(): ?string {
        $max = (int) $this->context->query_option('download.maxEntries', Archive::DEFAULT_MAX_ENTRIES);
        return count($this->entries) > $max ? 'too many files for one download (max ' . $max . ')' : null;
    }

    private function add_dir(string $real_dir, string $archived_dir): void {
        $real = realpath($real_dir);
        if ($real === false || isset($this->visited[$real])) {
            return; // symlink cycle or vanished
        }
        $this->visited[$real] = true;
        $this->entries[] = [$real_dir, $archived_dir, true];
        $this->add_dir_content($real_dir, $archived_dir);
    }

    private function add_dir_content(string $real_dir, string $archived_dir): void {
        // stop collecting early, check_size() reports the error
        if (count($this->entries) > (int) $this->context->query_option('download.maxEntries', Archive::DEFAULT_MAX_ENTRIES)) {
            return;
        }
        if ($archived_dir === '') {
            $real = realpath($real_dir);
            if ($real !== false) {
                $this->visited[$real] = true;
            }
        }
        foreach ($this->context->read_dir($real_dir) as $name) {
            $real_file = $real_dir . '/' . $name;
            $archived_file = ($archived_dir === '' ? '' : $archived_dir . '/') . $name;

            if (is_dir($real_file)) {
                if ($this->context->is_managed_path($real_file) && $this->context->can($real_file, Acl::DOWNLOAD)) {
                    $this->add_dir($real_file, $archived_file);
                }
            } elseif (is_file($real_file) && is_readable($real_file) && $this->context->can($real_dir, Acl::DOWNLOAD)) {
                $this->entries[] = [$real_file, $archived_file, false];
            }
        }
    }

    // RFC 6266 Content-Disposition with ASCII fallback and UTF-8 filename*.
    public static function content_disposition(string $name): string {
        $name = preg_replace('/[\x00-\x1f\x7f\/\\\\]+/u', '_', $name) ?? '';
        $name = trim(mb_substr($name, 0, 200, 'UTF-8'), " .\t");
        if ($name === '') {
            $name = 'download';
        }
        $ascii = preg_replace('/[^\x20-\x7e]|["%;]/', '_', $name);
        return 'attachment; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($name);
    }

    public function send(string $as): void {
        set_time_limit(0);
        @ini_set('zlib.output_compression', '0');
        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        header('Content-Type: ' . ($this->type === 'shell-zip' ? 'application/zip' : 'application/x-tar'));
        header('Content-Disposition: ' . Archive::content_disposition($as));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');
        // stream straight to the client, nginx would otherwise spool large archives to disk
        header('X-Accel-Buffering: no');

        if ($this->type === 'php-tar') {
            $this->php_tar();
        } else {
            $this->shell_archive();
        }
    }

    // ---- shell tar / zip -----------------------------------------------------------------

    private function shell_archive(): void {
        $list_file = tempnam(sys_get_temp_dir(), 'h6ai-archive-');
        if ($list_file === false) {
            return;
        }

        try {
            if ($this->type === 'shell-tar') {
                $names = array_map(fn ($e) => $e[1], $this->entries);
                if (!$names) {
                    $names = ['.'];
                }
                file_put_contents($list_file, implode(Archive::NUL, $names));
                $argv = ['tar', '--no-recursion', '--null', '-c', '-f', '-', '-T', $list_file];
                $stdin = ['file', '/dev/null', 'r'];
            } else {
                // zip reads newline separated names from stdin, skip names it can't represent
                $names = array_filter(array_map(fn ($e) => $e[1] . ($e[2] ? '/' : ''), $this->entries), fn ($n) => !str_contains($n, "\n"));
                file_put_contents($list_file, implode("\n", $names) . "\n");
                $argv = ['zip', '-q', '-', '-@'];
                $stdin = ['file', $list_file, 'r'];
            }

            $proc = proc_open($argv, [0 => $stdin, 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, $this->base_path);
            if (!is_resource($proc)) {
                return;
            }
            // pipes deliver <= 64 KiB per read: let PHP copy in large blocks instead of
            // echo + flush per pipe chunk (which capped shell archives at ~24 MiB/s)
            $out = fopen('php://output', 'wb');
            if ($out !== false) {
                stream_copy_to_stream($pipes[1], $out);
                fclose($out);
            }
            fclose($pipes[1]);
            proc_close($proc);
        } finally {
            @unlink($list_file);
        }
    }

    // ---- php tar -------------------------------------------------------------------------

    private function php_tar(): void {
        $headers = [];
        $total = 2 * Archive::BLOCK; // end of archive marker
        foreach ($this->entries as $idx => [$real, $name, $is_dir]) {
            $size = $is_dir ? 0 : (int) @filesize($real);
            $mtime = (int) @filemtime($real);
            $header = $this->tar_header($is_dir ? $name . '/' : $name, $size, $mtime, $is_dir);
            $headers[$idx] = [$header, $size];
            $total += strlen($header) + Archive::padded($size);
        }

        header('Content-Length: ' . $total);

        foreach ($this->entries as $idx => [$real, , $is_dir]) {
            if (connection_aborted()) {
                return;
            }
            [$header, $size] = $headers[$idx];
            echo $header;
            if (!$is_dir) {
                $this->print_file($real, $size);
                $rest = Archive::padded($size) - $size;
                if ($rest > 0) {
                    echo str_repeat(Archive::NUL, $rest);
                }
            }
        }
        echo str_repeat(Archive::NUL, 2 * Archive::BLOCK);
        flush();
    }

    private static function padded(int $size): int {
        return (int) (ceil($size / Archive::BLOCK) * Archive::BLOCK);
    }

    private static function octal(int $value, int $length): string {
        return str_pad(decoct($value), $length - 1, '0', STR_PAD_LEFT) . Archive::NUL;
    }

    private static function pax_record(string $key, string $value): string {
        $payload = ' ' . $key . '=' . $value . "\n";
        $len = strlen($payload) + strlen((string) strlen($payload));
        while (strlen($len . $payload) !== $len) {
            $len = strlen($len . $payload);
        }
        return $len . $payload;
    }

    private static function ustar_block(string $name, int $size, int $mtime, string $type, int $mode): string {
        $header =
            str_pad(substr($name, 0, 100), 100, Archive::NUL)    // name
            . Archive::octal($mode, 8)                           // mode
            . Archive::octal(0, 8)                               // uid
            . Archive::octal(0, 8)                               // gid
            . Archive::octal($size, 12)                          // size
            . Archive::octal(max(0, $mtime), 12)                 // mtime
            . '        '                                         // checksum placeholder
            . $type                                              // typeflag
            . str_repeat(Archive::NUL, 100)                      // linkname
            . 'ustar' . Archive::NUL . '00'                      // magic + version
            . str_repeat(Archive::NUL, 32 + 32 + 8 + 8)          // uname, gname, devmajor, devminor
            . str_repeat(Archive::NUL, 155)                      // prefix
            . str_repeat(Archive::NUL, 12);                      // padding

        $checksum = array_sum(array_map('ord', str_split($header)));
        $checksum = str_pad(decoct($checksum), 6, '0', STR_PAD_LEFT) . Archive::NUL . ' ';
        return substr_replace($header, $checksum, 148, 8);
    }

    // ustar header, preceded by a PAX extended header if the name is longer than 100 bytes
    // or the size exceeds the ustar limit (8 GiB).
    private function tar_header(string $name, int $size, int $mtime, bool $is_dir): string {
        $pax = '';
        if (strlen($name) > 100) {
            $pax .= Archive::pax_record('path', $name);
        }
        if ($size > Archive::USTAR_MAX_SIZE) {
            $pax .= Archive::pax_record('size', (string) $size);
        }

        $out = '';
        if ($pax !== '') {
            $pax_name = 'PaxHeaders/' . substr(basename($name), 0, 80);
            $out .= Archive::ustar_block($pax_name, strlen($pax), $mtime, 'x', 0644);
            $out .= str_pad($pax, Archive::padded(strlen($pax)), Archive::NUL);
        }

        $out .= Archive::ustar_block(
            $name,
            $size > Archive::USTAR_MAX_SIZE ? 0 : $size,
            $mtime,
            $is_dir ? '5' : '0',
            $is_dir ? 0755 : 0644
        );
        return $out;
    }

    // Streams exactly $size bytes (pads with NUL if the file shrank meanwhile) in segments
    // to stay below PHP's memory limit.
    private function print_file(string $file, int $size): void {
        $sent = 0;
        $fd = @fopen($file, 'rb');
        if ($fd !== false) {
            while ($sent < $size && !feof($fd)) {
                $chunk = fread($fd, min(Archive::SEGMENT_SIZE, $size - $sent));
                if ($chunk === false || $chunk === '') {
                    break;
                }
                echo $chunk;
                $sent += strlen($chunk);
                flush();
            }
            fclose($fd);
        }
        while ($sent < $size) {
            $len = min(Archive::SEGMENT_SIZE, $size - $sent);
            echo str_repeat(Archive::NUL, $len);
            $sent += $len;
        }
    }
}

<?php
declare(strict_types=1);

// Append-only activity log (downloads, archive downloads, logins) in private/data/logs, one JSON
// object per line, one file per month. Reading scans files backwards, so the newest entries are
// cheap to get even for large logs.
final class ActivityLog {
    private const MAX_SCAN_LINES = 200000;
    private const CHUNK = 65536;

    private string $dir;

    public function __construct(private readonly Context $context) {
        $this->dir = $context->get_setup()->get('DATA_PATH') . '/logs';
    }

    public function is_enabled(): bool {
        return $this->context->get_settings()->get('activityLog.enabled') === true;
    }

    public function log(string $kind, ?string $path, array $extra = []): void {
        if (!$this->is_enabled()) {
            return;
        }
        if (!is_dir($this->dir) && !@mkdir($this->dir, 0700, true)) {
            return;
        }
        $user = $this->context->get_user();
        $entry = array_merge([
            'time' => time(),
            'kind' => $kind,
            'user' => $user['name'] ?? null,
            'ip' => $this->context->get_request()->client_ip(),
            'path' => $path
        ], $extra);
        $line = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($line !== false) {
            @file_put_contents($this->dir . '/activity-' . gmdate('Y-m') . '.jsonl', $line . "\n", FILE_APPEND | LOCK_EX);
        }
        if (random_int(1, 500) === 1) {
            $this->prune();
        }
    }

    // Deletes monthly files that only contain entries older than the retention period.
    public function prune(): void {
        $days = (int) $this->context->get_settings()->get('activityLog.retentionDays', 90);
        $cutoff = gmdate('Y-m', time() - $days * 86400);
        foreach (glob($this->dir . '/activity-*.jsonl') ?: [] as $file) {
            if (preg_match('/activity-(\d{4}-\d{2})\.jsonl$/', $file, $m) && $m[1] < $cutoff) {
                @unlink($file);
            }
        }
    }

    // Yields lines of a file from the last to the first.
    private static function reverse_lines(string $file): Generator {
        $fp = @fopen($file, 'rb');
        if ($fp === false) {
            return;
        }
        try {
            fseek($fp, 0, SEEK_END);
            $pos = ftell($fp);
            $buffer = '';
            while ($pos > 0) {
                $read = min(ActivityLog::CHUNK, $pos);
                $pos -= $read;
                fseek($fp, $pos);
                $buffer = fread($fp, $read) . $buffer;
                $lines = explode("\n", $buffer);
                $buffer = array_shift($lines);
                for ($i = count($lines) - 1; $i >= 0; $i -= 1) {
                    if ($lines[$i] !== '') {
                        yield $lines[$i];
                    }
                }
            }
            if ($buffer !== '') {
                yield $buffer;
            }
        } finally {
            fclose($fp);
        }
    }

    public function query(int $limit, ?string $user, ?string $kind, ?string $path): array {
        $files = glob($this->dir . '/activity-*.jsonl') ?: [];
        rsort($files);

        $entries = [];
        $scanned = 0;
        $by_path = [];
        $by_user = [];
        $counts = [];
        $bytes = 0;
        foreach ($files as $file) {
            foreach (ActivityLog::reverse_lines($file) as $line) {
                if (++$scanned > ActivityLog::MAX_SCAN_LINES) {
                    break 2;
                }
                $entry = json_decode($line, true);
                if (!is_array($entry)) {
                    continue;
                }
                if (($user !== null && ($user === '' ? $entry['user'] !== null : $entry['user'] !== $user))
                    || ($kind !== null && $entry['kind'] !== $kind)
                    || ($path !== null && !str_contains((string) $entry['path'], $path))) {
                    continue;
                }
                $counts[$entry['kind']] = ($counts[$entry['kind']] ?? 0) + 1;
                if ($entry['kind'] === 'file' && is_int($entry['size'] ?? null)) {
                    $bytes += $entry['size'];
                }
                if (in_array($entry['kind'], ['file', 'archive'], true)) {
                    $by_path[$entry['path']] = ($by_path[$entry['path']] ?? 0) + 1;
                    $who = $entry['user'] ?? '(guest)';
                    $by_user[$who] = ($by_user[$who] ?? 0) + 1;
                }
                if (count($entries) < $limit) {
                    $entries[] = $entry;
                }
            }
        }
        arsort($by_path);
        arsort($by_user);
        $top = fn ($counts) => array_map(fn ($k, $v) => ['name' => (string) $k, 'count' => $v], array_keys($counts), array_values($counts));

        return [
            'entries' => $entries,
            'stats' => [
                'scanned' => min($scanned, ActivityLog::MAX_SCAN_LINES),
                'counts' => $counts,
                // sizes of the files whose download started (completion isn't visible to h6ai)
                'bytes' => $bytes,
                'topFiles' => array_slice($top($by_path), 0, 10),
                'topUsers' => array_slice($top($by_user), 0, 10)
            ]
        ];
    }
}

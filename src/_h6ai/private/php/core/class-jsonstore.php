<?php
declare(strict_types=1);

// A JSON file in private/data with safe concurrent updates: writers serialise on a lock file and
// replace the file atomically (rename), so readers never see a half written file and need no lock.
final class JsonStore {
    private string $lock_file;
    private ?array $data = null;

    public function __construct(
        private readonly string $file,
        private readonly string $cache_path
    ) {
        $this->lock_file = $file . '.lock';
    }

    public function is_writable(): bool {
        $dir = dirname($this->file);
        return is_dir($dir) && is_writable($dir);
    }

    // Raw content ([] if missing, null if invalid JSON).
    public function load(): ?array {
        if ($this->data === null) {
            $this->data = Json::load_cached($this->file, $this->cache_path) ?? [];
        }
        return $this->data;
    }

    // Runs $fn(current data) under an exclusive lock and persists the returned data.
    public function update(callable $fn): array {
        if (!$this->is_writable()) {
            throw new RuntimeException('data directory is not writable');
        }
        $lock = fopen($this->lock_file, 'c');
        if ($lock === false) {
            throw new RuntimeException('cannot open lock file');
        }
        try {
            flock($lock, LOCK_EX);
            clearstatcache(true, $this->file);
            $next = $fn(Json::load($this->file) ?? []);

            $tmp = $this->file . '.' . bin2hex(random_bytes(6)) . '.tmp';
            $json = json_encode($next, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($json === false || file_put_contents($tmp, $json . "\n") === false) {
                @unlink($tmp);
                throw new RuntimeException('cannot write ' . basename($this->file));
            }
            @chmod($tmp, 0600);
            if (!rename($tmp, $this->file)) {
                @unlink($tmp);
                throw new RuntimeException('cannot replace ' . basename($this->file));
            }
            $this->data = $next;
            return $next;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

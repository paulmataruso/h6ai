<?php
declare(strict_types=1);

// A JSON file in private/data with safe concurrent updates: writers serialise on a lock file and
// replace the file atomically (rename), so readers never see a half written file and need no lock.
// Stored guarded (auth.json -> auth.json.php, see Json::GUARD); a plain file from an older version
// is read until the next write replaces it.
final class JsonStore {
    private string $file;
    private string $legacy_file;
    private string $lock_file;
    private ?array $data = null;

    public function __construct(string $file, private readonly string $cache_path) {
        $this->file = $file . '.php';
        $this->legacy_file = $file;
        $this->lock_file = $file . '.lock';
    }

    private function source(): string {
        return !is_file($this->file) && is_file($this->legacy_file) ? $this->legacy_file : $this->file;
    }

    public function is_writable(): bool {
        $dir = dirname($this->file);
        return is_dir($dir) && is_writable($dir);
    }

    // Raw content ([] if missing, null if invalid JSON).
    public function load(): ?array {
        if ($this->data === null) {
            $this->data = Json::load_cached($this->source(), $this->cache_path) ?? [];
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
            clearstatcache(true, $this->legacy_file);
            $next = $fn(Json::load($this->source()) ?? []);

            $json = json_encode($next, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($json === false || !Json::write_guarded($this->file, $json . "\n")) {
                throw new RuntimeException('cannot write ' . basename($this->file));
            }
            if (is_file($this->legacy_file)) {
                @unlink($this->legacy_file);
            }
            $this->data = $next;
            return $next;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

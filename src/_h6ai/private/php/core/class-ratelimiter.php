<?php
declare(strict_types=1);

// File based fixed-window limiter for failed logins, keyed by a hash of the client IP.
final class RateLimiter {
    private string $file;

    public function __construct(string $cache_path, string $key, private readonly int $max_attempts, private readonly int $window) {
        $this->file = $cache_path . '/ratelimit-' . hash('sha256', $key) . '.json';
    }

    private function with_lock(callable $fn): mixed {
        $dir = dirname($this->file);
        if (!is_dir($dir) || !is_writable($dir)) {
            // no writable private cache: fail open (logins still go through password_verify)
            return $fn([])[0];
        }
        $fp = @fopen($this->file, 'c+');
        if ($fp === false) {
            return $fn([])[0];
        }
        try {
            flock($fp, LOCK_EX);
            $raw = stream_get_contents($fp);
            $data = is_string($raw) ? json_decode($raw, true) : null;
            $attempts = is_array($data) ? array_values(array_filter($data, 'is_int')) : [];
            $now = time();
            $attempts = array_values(array_filter($attempts, fn ($t) => $t > $now - $this->window));
            [$result, $attempts] = $fn($attempts);
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($attempts));
            fflush($fp);
            return $result;
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }

    public function is_limited(): bool {
        return $this->with_lock(fn ($attempts) => [count($attempts) >= $this->max_attempts, $attempts]) === true;
    }

    public function hit(): void {
        $this->with_lock(function ($attempts) {
            $attempts[] = time();
            return [null, $attempts];
        });
    }

    public function reset(): void {
        @unlink($this->file);
    }
}

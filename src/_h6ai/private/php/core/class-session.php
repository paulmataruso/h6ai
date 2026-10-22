<?php
declare(strict_types=1);

// Lazy session wrapper. A session (and its cookie) is only created when something is written,
// e.g. on a successful login. Anonymous visitors never get a session cookie.
final class Session {
    private const KEY_PREFIX = '__H6AI__';
    private const NAME = 'h6ai_session';

    private bool $started = false;
    private bool $writable = false;
    private bool $configured = false;

    public function __construct(private readonly bool $secure) {}

    private function configure(): void {
        if ($this->configured) {
            return;
        }
        $this->configured = true;
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');
        ini_set('session.cookie_httponly', '1');
        session_name(Session::NAME);
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'secure' => $this->secure,
            'httponly' => true,
            'samesite' => 'Strict'
        ]);
    }

    private function has_cookie(): bool {
        return isset($_COOKIE[Session::NAME]) && is_string($_COOKIE[Session::NAME]) && $_COOKIE[Session::NAME] !== '';
    }

    private function start(bool $for_writing): void {
        if ($this->started && ($this->writable || !$for_writing)) {
            return;
        }
        $this->configure();
        if ($for_writing) {
            session_start();
            $this->writable = true;
        } else {
            session_start(['read_and_close' => true]);
        }
        $this->started = true;
    }

    public function get(string $key, mixed $default = null): mixed {
        if (!$this->started) {
            if (!$this->has_cookie()) {
                return $default;
            }
            $this->start(false);
        }
        return $_SESSION[Session::KEY_PREFIX . $key] ?? $default;
    }

    public function set(string $key, mixed $value): void {
        $this->start(true);
        $_SESSION[Session::KEY_PREFIX . $key] = $value;
    }

    // New session id, prevents session fixation. Call on privilege change.
    public function regenerate(): void {
        $this->start(true);
        session_regenerate_id(true);
    }

    public function destroy(): void {
        if (!$this->has_cookie() && !$this->started) {
            return;
        }
        $this->start(true);
        $_SESSION = [];
        session_destroy();
        $params = session_get_cookie_params();
        setcookie(Session::NAME, '', [
            'expires' => time() - 3600,
            'path' => $params['path'],
            'secure' => $params['secure'],
            'httponly' => true,
            'samesite' => 'Strict'
        ]);
    }

    public function close(): void {
        if ($this->started && $this->writable) {
            session_write_close();
            $this->writable = false;
        }
    }
}

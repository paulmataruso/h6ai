<?php
declare(strict_types=1);

final class Request {
    private const MAX_BODY_BYTES = 1048576;

    private array $params;
    private array $server;

    public function __construct(array $params, array $server = []) {
        $this->params = $params;
        $this->server = $server;
    }

    // Parameters are only taken from the POST body. JSON is only accepted with a JSON content
    // type, so cross-site "simple" requests (text/plain forms) can't smuggle JSON payloads.
    // Cookies and query string are never mixed in (unlike $_REQUEST).
    public static function from_globals(): Request {
        $params = [];
        if (strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            $content_type = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
            if ($content_type === 'application/json') {
                $body = file_get_contents('php://input', false, null, 0, self::MAX_BODY_BYTES);
                $data = is_string($body) ? json_decode($body, true, 64) : null;
                $params = is_array($data) ? $data : [];
            } else {
                $params = $_POST;
            }
        }
        return new Request($params, $_SERVER);
    }

    public function header(string $name): ?string {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        $value = $this->server[$key] ?? null;
        return is_string($value) ? $value : null;
    }

    public function client_ip(): string {
        $ip = $this->server['REMOTE_ADDR'] ?? '';
        return is_string($ip) ? $ip : '';
    }

    public function is_https(): bool {
        $https = $this->server['HTTPS'] ?? '';
        return (is_string($https) && $https !== '' && strtolower($https) !== 'off')
            || ($this->server['SERVER_PORT'] ?? null) == 443
            || strtolower((string) ($this->server['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    }

    // Rejects requests a browser marks as cross-site, and requests whose Origin host differs
    // from the Host header. Requests without these headers (curl, old browsers) pass.
    public function is_same_origin(): bool {
        $site = $this->header('Sec-Fetch-Site');
        if ($site !== null && !in_array(strtolower($site), ['same-origin', 'none'], true)) {
            return false;
        }

        $origin = $this->header('Origin');
        if ($origin === null || $origin === '') {
            return true;
        }

        $parts = parse_url($origin);
        if (!is_array($parts) || !isset($parts['host'])) {
            return false;
        }
        $origin_host = strtolower($parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : ''));
        $host = strtolower((string) $this->header('Host'));

        if ($origin_host === $host) {
            return true;
        }
        // tolerate default ports being present in only one of the two
        $strip_default_port = fn ($h) => preg_replace('/:(80|443)$/', '', $h);
        return $strip_default_port($origin_host) === $strip_default_port($host);
    }

    public function query(string $keypath = '', mixed $default = Util::NO_DEFAULT): mixed {
        $value = Util::array_query($this->params, $keypath, Util::NO_DEFAULT);

        if ($value === Util::NO_DEFAULT) {
            Util::json_fail(Util::ERR_MISSING_PARAM, 'parameter \'' . $keypath . '\' is missing', $default === Util::NO_DEFAULT);
            return $default;
        }

        return $value;
    }

    public function query_string(string $keypath = '', mixed $default = Util::NO_DEFAULT): string {
        $value = $this->query($keypath, $default);
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'parameter \'' . $keypath . '\' is not a string', !is_string($value));
        return $value;
    }

    public function query_boolean(string $keypath = '', mixed $default = Util::NO_DEFAULT): bool {
        $value = $this->query($keypath, $default);
        return filter_var($value, FILTER_VALIDATE_BOOLEAN);
    }

    public function query_numeric(string $keypath = '', mixed $default = Util::NO_DEFAULT): int {
        $value = $this->query($keypath, $default);
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'parameter \'' . $keypath . '\' is not numeric', !is_numeric($value));
        return intval($value, 10);
    }

    public function query_array(string $keypath = '', mixed $default = Util::NO_DEFAULT): array {
        $value = $this->query($keypath, $default);
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'parameter \'' . $keypath . '\' is no array', !is_array($value));
        return $value;
    }
}

<?php
declare(strict_types=1);

final class Request {
    private const MAX_BODY_BYTES = 1048576;

    private array $params;
    private array $server;
    // reverse proxy settings (admin: System tab), see configure_proxy()
    private array $trusted_proxies = [];
    private string $public_url = '';

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

    // Reverse proxy support. X-Forwarded-For and X-Forwarded-Host are only believed when the
    // request comes from one of the trusted proxies (IPs or CIDR ranges). The public URL
    // ("https://files.example.com") is the address visitors use, for absolute links and the
    // same-origin check.
    public function configure_proxy(array $trusted, string $public_url): void {
        $this->trusted_proxies = array_values(array_filter($trusted, fn ($c) => is_string($c) && Request::is_valid_cidr($c)));
        $this->public_url = $public_url;
    }

    public static function is_valid_cidr(string $cidr): bool {
        return Request::parse_cidr($cidr) !== null;
    }

    // "10.0.0.0/8", "2001:db8::/32" or a single address -> [packed network, prefix length]
    private static function parse_cidr(string $cidr): ?array {
        [$address, $bits] = array_pad(explode('/', trim($cidr), 2), 2, null);
        $packed = @inet_pton((string) $address);
        if ($packed === false) {
            return null;
        }
        $max = strlen($packed) * 8;
        if ($bits === null) {
            return [$packed, $max];
        }
        if (!preg_match('/^\d{1,3}$/', $bits) || (int) $bits > $max) {
            return null;
        }
        return [$packed, (int) $bits];
    }

    private static function ip_in_cidr(string $ip, string $cidr): bool {
        $packed = @inet_pton($ip);
        $net = Request::parse_cidr($cidr);
        if ($packed === false || $net === null || strlen($packed) !== strlen($net[0])) {
            return false;
        }
        [$network, $bits] = $net;
        $bytes = intdiv($bits, 8);
        if (substr($packed, 0, $bytes) !== substr($network, 0, $bytes)) {
            return false;
        }
        $rest = $bits % 8;
        if ($rest === 0) {
            return true;
        }
        $mask = (0xff << (8 - $rest)) & 0xff;
        return (ord($packed[$bytes]) & $mask) === (ord($network[$bytes]) & $mask);
    }

    private function is_trusted_proxy(string $ip): bool {
        foreach ($this->trusted_proxies as $cidr) {
            if (Request::ip_in_cidr($ip, $cidr)) {
                return true;
            }
        }
        return false;
    }

    // The address the request came from (the proxy's, behind a reverse proxy).
    public function remote_addr(): string {
        $ip = $this->server['REMOTE_ADDR'] ?? '';
        return is_string($ip) ? $ip : '';
    }

    public function from_trusted_proxy(): bool {
        return $this->trusted_proxies && $this->is_trusted_proxy($this->remote_addr());
    }

    // The visitor's address: behind trusted proxies the right-most X-Forwarded-For entry that
    // isn't a trusted proxy itself (entries further left are whatever the client claimed).
    public function client_ip(): string {
        $remote = $this->remote_addr();
        if (!$this->from_trusted_proxy()) {
            return $remote;
        }
        $hops = array_reverse(array_map('trim', explode(',', (string) $this->header('X-Forwarded-For'))));
        $last = null;
        foreach ($hops as $hop) {
            if (filter_var($hop, FILTER_VALIDATE_IP) === false) {
                break;
            }
            if (!$this->is_trusted_proxy($hop)) {
                return $hop;
            }
            $last = $hop;
        }
        if ($last === null) {
            $real = trim((string) $this->header('X-Real-IP'));
            if (filter_var($real, FILTER_VALIDATE_IP) !== false) {
                return $real;
            }
        }
        return $last ?? $remote;
    }

    public function is_https(): bool {
        $https = $this->server['HTTPS'] ?? '';
        // without configured proxies X-Forwarded-Proto is believed as before (it only ever makes
        // cookies stricter); with them, only from a trusted proxy
        $forwarded = strtolower((string) ($this->server['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https'
            && (!$this->trusted_proxies || $this->from_trusted_proxy());
        return (is_string($https) && $https !== '' && strtolower($https) !== 'off')
            || ($this->server['SERVER_PORT'] ?? null) == 443
            || $forwarded;
    }

    private static function valid_host(string $host): bool {
        return preg_match('/^[A-Za-z0-9.\-:\[\]]{1,255}$/', $host) === 1;
    }

    // scheme://host[:port] visitors use: the configured public URL, else what a trusted proxy
    // forwarded, else this request's own Host.
    public function public_origin(): string {
        if ($this->public_url !== '') {
            return $this->public_url;
        }
        $host = (string) ($this->header('Host') ?? '');
        if ($this->from_trusted_proxy()) {
            $forwarded = trim(explode(',', (string) $this->header('X-Forwarded-Host'))[0]);
            if ($forwarded !== '' && Request::valid_host($forwarded)) {
                $host = $forwarded;
            }
        }
        return ($this->is_https() ? 'https' : 'http') . '://' . (Request::valid_host($host) ? $host : 'localhost');
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
        // the Host the request arrived with; behind a proxy also the public and forwarded host
        $hosts = [strtolower((string) $this->header('Host'))];
        if ($this->public_url !== '') {
            $hosts[] = strtolower((string) parse_url($this->public_url, PHP_URL_HOST)
                . (parse_url($this->public_url, PHP_URL_PORT) ? ':' . parse_url($this->public_url, PHP_URL_PORT) : ''));
        }
        if ($this->from_trusted_proxy() && $this->header('X-Forwarded-Host') !== null) {
            $hosts[] = strtolower(trim(explode(',', (string) $this->header('X-Forwarded-Host'))[0]));
        }

        // tolerate default ports being present in only one of the two
        $strip_default_port = fn ($h) => preg_replace('/:(80|443)$/', '', $h);
        foreach ($hosts as $host) {
            if ($host !== '' && ($origin_host === $host || $strip_default_port($origin_host) === $strip_default_port($host))) {
                return true;
            }
        }
        return false;
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

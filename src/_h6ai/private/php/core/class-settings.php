<?php
declare(strict_types=1);

// Site settings managed in the admin UI (private/data/settings.json): site name, anonymous mode,
// reverse proxy, Google integration (Search Console, Tag Manager, Analytics), search engine
// indexing, activity log.
final class Settings {
    public const THEMES = ['midnight', 'graphite', 'deepsea', 'ember', 'oled'];
    public const CLICK_ACTIONS = ['expand', 'download-other', 'download'];

    public const DEFAULTS = [
        'siteName' => 'h6ai',
        'visitors' => [
            // anonymous mode: no sign-in in the listing, everyone browses and downloads everything
            // except excluded folders ("everyone: none" rules); only admins sign in, on the admin page
            'anonymous' => false
        ],
        'proxy' => [
            // the address visitors use, e.g. "https://files.example.com" ('' = each request's own)
            'publicUrl' => '',
            // IPs / CIDR ranges of reverse proxies whose X-Forwarded-* headers are believed
            'trusted' => []
        ],
        'appearance' => [
            // site default theme, visitors may pick another one for themselves
            'theme' => 'midnight',
            // what a click on a file name does: "expand" = preview, else unfold the download
            // band; "download-other" = preview, else download; "download" = always download
            'clickAction' => 'expand'
        ],
        'google' => [
            'verification' => '',
            'tagManagerId' => '',
            'measurementId' => '',
            'apiSecret' => '',
            'trackDownloads' => true,
            'serverSideDownloads' => true,
            'sendUserNames' => false
        ],
        'seo' => [
            'allowIndexing' => true,
            'sitemap' => true
        ],
        'activityLog' => [
            'enabled' => true,
            'retentionDays' => 90
        ]
    ];

    private const VERIFICATION_RE = '/^[A-Za-z0-9_-]{10,128}$/';
    private const GTM_RE = '/^GTM-[A-Z0-9]{4,12}$/';
    private const GA4_RE = '/^G-[A-Z0-9]{4,16}$/';
    private const SECRET_RE = '/^[A-Za-z0-9_-]{8,64}$/';
    private const MAX_PROXIES = 32;

    private JsonStore $store;
    private ?array $settings = null;

    public function __construct(string $data_path, string $cache_path) {
        $this->store = new JsonStore($data_path . '/settings.json', $cache_path);
    }

    public function is_writable(): bool {
        return $this->store->is_writable();
    }

    public function all(): array {
        if ($this->settings === null) {
            $this->settings = Util::array_merge_deep(Settings::DEFAULTS, $this->store->load() ?? []);
        }
        return $this->settings;
    }

    public function get(string $keypath, mixed $default = null): mixed {
        return Util::array_query($this->all(), $keypath, $default);
    }

    public function has_google_analytics(): bool {
        return $this->get('google.measurementId') !== '';
    }

    public function has_tag_manager(): bool {
        return $this->get('google.tagManagerId') !== '';
    }

    public function is_server_side_tracking(): bool {
        return $this->has_google_analytics() && $this->get('google.apiSecret') !== '' && $this->get('google.serverSideDownloads') === true;
    }

    // What the admin UI may see: the Measurement Protocol secret is write-only.
    public function to_admin(): array {
        $settings = $this->all();
        $settings['google']['apiSecretSet'] = $settings['google']['apiSecret'] !== '';
        unset($settings['google']['apiSecret']);
        return $settings;
    }

    // What every visitor's browser needs.
    public function to_public(): array {
        return [
            'name' => $this->get('siteName'),
            'theme' => $this->get('appearance.theme'),
            'themes' => Settings::THEMES,
            'clickAction' => $this->get('appearance.clickAction'),
            // for absolute links (direct link, curl/wget lines, QR code); '' = the page's own address
            'publicUrl' => $this->get('proxy.publicUrl'),
            'google' => [
                'measurementId' => $this->get('google.measurementId'),
                'tagManagerId' => $this->get('google.tagManagerId'),
                'trackDownloads' => $this->get('google.trackDownloads') === true,
                // downloads are reported by the server, the browser must not count them twice
                'serverSideDownloads' => $this->is_server_side_tracking()
            ]
        ];
    }

    // Extracts IDs from pasted Google snippets: the Search Console verification meta tag, the
    // Tag Manager container snippet and the gtag.js (GA4) snippet. Raw HTML is never stored.
    public static function parse_snippet(string $snippet): array {
        $found = [];
        if (preg_match('/<meta\b[^>]*\bname\s*=\s*["\']google-site-verification["\'][^>]*>/i', $snippet, $meta)
            && preg_match('/\bcontent\s*=\s*["\']([^"\']+)["\']/i', $meta[0], $content)) {
            $found['verification'] = trim($content[1]);
        } elseif (preg_match('/^\s*([A-Za-z0-9_-]{30,128})\s*$/', $snippet, $token)) {
            $found['verification'] = $token[1]; // just the token
        }
        if (preg_match('/\b(GTM-[A-Z0-9]{4,12})\b/', $snippet, $gtm)) {
            $found['tagManagerId'] = $gtm[1];
        }
        if (preg_match('/\b(G-[A-Z0-9]{4,16})\b/', $snippet, $ga)) {
            $found['measurementId'] = $ga[1];
        }
        return $found;
    }

    // "files.example.com", "https://files.example.com/" -> "https://files.example.com"; scheme,
    // host and port only (h6ai lives at the root of the site).
    public static function clean_public_url(mixed $value): string {
        Settings::check(is_string($value), 'invalid public address');
        $value = trim($value);
        if ($value === '') {
            return '';
        }
        if (!preg_match('#^[a-z][a-z0-9+.-]*://#i', $value)) {
            $value = 'https://' . $value;
        }
        $parts = parse_url($value);
        $msg = 'public address must look like https://files.example.com';
        Settings::check(is_array($parts) && isset($parts['host']), $msg);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        Settings::check(in_array($scheme, ['http', 'https'], true), 'the public address must start with http:// or https://');
        Settings::check(!isset($parts['user']) && !isset($parts['pass']) && !isset($parts['query']) && !isset($parts['fragment']), $msg);
        Settings::check(($parts['path'] ?? '/') === '/' || ($parts['path'] ?? '') === '', 'the public address can\'t have a path: h6ai runs at the root of the site');
        $host = strtolower($parts['host']);
        Settings::check(preg_match('/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*)$/', $host) === 1, $msg);
        $port = isset($parts['port']) ? (int) $parts['port'] : null;
        $default = $scheme === 'https' ? 443 : 80;
        return $scheme . '://' . $host . ($port !== null && $port !== $default ? ':' . $port : '');
    }

    private static function check(bool $cond, string $msg): void {
        if (!$cond) {
            throw new InvalidArgumentException($msg);
        }
    }

    private static function bool_field(array $input, string $key, array &$target): void {
        if (array_key_exists($key, $input)) {
            Settings::check(is_bool($input[$key]), $key . ' must be true or false');
            $target[$key] = $input[$key];
        }
    }

    public function save(array $input): array {
        $next = $this->all();

        if (array_key_exists('siteName', $input)) {
            $name = is_string($input['siteName']) ? trim(preg_replace('/[\x00-\x1f\x7f<>]/u', '', $input['siteName']) ?? '') : '';
            Settings::check($name !== '' && mb_strlen($name) <= 60, 'site name must have 1 to 60 characters');
            $next['siteName'] = $name;
        }

        $proxy = is_array($input['proxy'] ?? null) ? $input['proxy'] : [];
        if (array_key_exists('publicUrl', $proxy)) {
            $next['proxy']['publicUrl'] = Settings::clean_public_url($proxy['publicUrl']);
        }
        if (array_key_exists('trusted', $proxy)) {
            $list = is_string($proxy['trusted']) ? preg_split('/[\s,]+/', $proxy['trusted']) : $proxy['trusted'];
            Settings::check(is_array($list), 'trusted proxies must be a list');
            $clean = [];
            foreach ($list as $entry) {
                Settings::check(is_string($entry), 'invalid trusted proxy');
                $entry = trim($entry);
                if ($entry !== '') {
                    Settings::check(Request::is_valid_cidr($entry), 'not an IP address or CIDR range: ' . mb_substr($entry, 0, 64));
                    $clean[$entry] = true;
                }
            }
            Settings::check(count($clean) <= Settings::MAX_PROXIES, 'at most ' . Settings::MAX_PROXIES . ' trusted proxies');
            $next['proxy']['trusted'] = array_keys($clean);
        }

        $visitors = is_array($input['visitors'] ?? null) ? $input['visitors'] : [];
        Settings::bool_field($visitors, 'anonymous', $next['visitors']);

        $appearance = is_array($input['appearance'] ?? null) ? $input['appearance'] : [];
        if (array_key_exists('theme', $appearance)) {
            Settings::check(in_array($appearance['theme'], Settings::THEMES, true), 'unknown theme');
            $next['appearance']['theme'] = $appearance['theme'];
        }
        if (array_key_exists('clickAction', $appearance)) {
            Settings::check(in_array($appearance['clickAction'], Settings::CLICK_ACTIONS, true), 'unknown click action');
            $next['appearance']['clickAction'] = $appearance['clickAction'];
        }

        $google = is_array($input['google'] ?? null) ? $input['google'] : [];
        if (is_string($google['snippet'] ?? null) && trim($google['snippet']) !== '') {
            $parsed = Settings::parse_snippet($google['snippet']);
            Settings::check($parsed !== [], 'no Google verification tag, GTM-… or G-… id found in the pasted code');
            $google = array_merge($parsed, array_diff_key($google, $parsed));
        }
        foreach ([
            'verification' => [Settings::VERIFICATION_RE, 'invalid Search Console verification token'],
            'tagManagerId' => [Settings::GTM_RE, 'invalid Tag Manager id (GTM-XXXXXXX)'],
            'measurementId' => [Settings::GA4_RE, 'invalid Analytics measurement id (G-XXXXXXXXXX)'],
            'apiSecret' => [Settings::SECRET_RE, 'invalid Measurement Protocol API secret']
        ] as $key => [$re, $msg]) {
            if (array_key_exists($key, $google) && $google[$key] !== null) {
                Settings::check(is_string($google[$key]), $msg);
                $value = trim($google[$key]);
                Settings::check($value === '' || preg_match($re, $value) === 1, $msg);
                $next['google'][$key] = $value;
            }
        }
        foreach (['trackDownloads', 'serverSideDownloads', 'sendUserNames'] as $key) {
            Settings::bool_field($google, $key, $next['google']);
        }

        $seo = is_array($input['seo'] ?? null) ? $input['seo'] : [];
        foreach (['allowIndexing', 'sitemap'] as $key) {
            Settings::bool_field($seo, $key, $next['seo']);
        }

        $log = is_array($input['activityLog'] ?? null) ? $input['activityLog'] : [];
        Settings::bool_field($log, 'enabled', $next['activityLog']);
        if (array_key_exists('retentionDays', $log)) {
            $days = Util::to_int($log['retentionDays'], 1, 3650);
            Settings::check($days !== null, 'retention must be 1 to 3650 days');
            $next['activityLog']['retentionDays'] = $days;
        }

        $this->settings = Util::array_merge_deep(Settings::DEFAULTS, $this->store->update(fn () => $next));
        return $this->settings;
    }
}

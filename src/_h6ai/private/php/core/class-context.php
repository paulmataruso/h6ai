<?php
declare(strict_types=1);

final class Context {
    // SHA-512 of the empty string, the legacy preset. Treated as "no password set".
    private const DEFAULT_PASSHASH = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';
    private const DEFAULT_SESSION_MAX_AGE = 43200; // 12h
    // dummy bcrypt hash, verified against for unknown users to keep timing uniform
    private const DUMMY_HASH = '$2y$10$6KU3AobSx0tPU44NEs6ZvOCSdBTfMVUlt/juYmPFoidITf4Z1mPr2';
    private const L10N_ISO_CODES = [
        'af', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'he',
        'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lv', 'nb', 'nl', 'pl',
        'pt-br', 'pt-pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'tr', 'uk',
        'zh-cn', 'zh-tw'
    ];
    private const MAX_THUMB_REQUESTS = 200;

    private array $options;
    private bool $options_valid;
    private string $passhash;
    private ?Types $types = null;
    private ?AuthStore $auth_store = null;
    private ?Settings $settings = null;
    private ?Acl $acl = null;
    private ?array $user = null;
    private bool $user_resolved = false;

    public function __construct(
        private readonly Session $session,
        private readonly Request $request,
        private readonly Setup $setup
    ) {
        $conf_path = $this->setup->get('CONF_PATH');
        $cache_path = $this->setup->get('CACHE_PRV_PATH');
        $options = Json::load_cached($conf_path . '/options.json', $cache_path);
        $this->options_valid = $options !== null;
        $options = $options ?? [];

        // Local overrides survive upgrades: options.local.json, then options.local.php (the same
        // JSON behind a guard line, safe in a web root), deep-merged over options.json.
        foreach (['options.local.json', 'options.local.php'] as $name) {
            $local = Json::load_cached($conf_path . '/' . $name, $cache_path);
            if ($local === null) {
                Logger::log($name . ' is not valid JSON, ignored');
                $this->options_valid = false;
            } elseif ($local) {
                $options = Util::array_merge_deep($options, $local);
            }
        }
        $this->options = $options;

        // H5AI_PASSHASH: name used before the rename to h6ai
        $env_passhash = getenv('H6AI_PASSHASH') ?: getenv('H5AI_PASSHASH');
        $passhash = is_string($env_passhash) && $env_passhash !== '' ? $env_passhash : Util::array_query($this->options, 'passhash', '');
        $this->passhash = is_string($passhash) ? trim($passhash) : '';
        $this->options['hasCustomPasshash'] = $this->has_password();
        // never sent to browsers: a password hash and a server path
        unset($this->options['passhash'], $this->options['filesFolder']);
    }

    public function get_session(): Session {
        return $this->session;
    }

    public function get_request(): Request {
        return $this->request;
    }

    public function get_setup(): Setup {
        return $this->setup;
    }

    public function get_options(): array {
        return $this->options;
    }

    public function are_options_valid(): bool {
        return $this->options_valid;
    }

    public function query_option(string $keypath = '', mixed $default = null): mixed {
        return Util::array_query($this->options, $keypath, $default);
    }

    public function get_types(): array {
        return Json::load($this->setup->get('CONF_PATH') . '/types.json') ?? [];
    }

    public function get_type(string $name): string {
        if ($this->types === null) {
            $this->types = new Types($this->get_types());
        }
        return $this->types->get_type($name);
    }

    // ---- authentication ------------------------------------------------------------------

    public function get_settings(): Settings {
        if ($this->settings === null) {
            $this->settings = new Settings($this->setup->get('DATA_PATH'), $this->setup->get('CACHE_PRV_PATH'));
        }
        return $this->settings;
    }

    public function get_auth_store(): AuthStore {
        if ($this->auth_store === null) {
            $this->auth_store = new AuthStore($this->setup->get('DATA_PATH'), $this->setup->get('CACHE_PRV_PATH'));
        }
        return $this->auth_store;
    }

    // The legacy single admin password (passhash option or H6AI_PASSHASH env).
    public function has_legacy_password(): bool {
        return $this->passhash !== '' && strcasecmp($this->passhash, Context::DEFAULT_PASSHASH) !== 0;
    }

    // Bootstrap login with the legacy password, only while no enabled admin user exists.
    public function is_bootstrap_possible(): bool {
        return $this->has_legacy_password() && !$this->get_auth_store()->has_admin_user();
    }

    public function has_password(): bool {
        return $this->get_auth_store()->has_users() || $this->is_bootstrap_possible();
    }

    // Anonymous mode (admin setting): no sign-in for visitors, only admins log in.
    public function is_anonymous_mode(): bool {
        return $this->get_settings()->get('visitors.anonymous') === true;
    }

    private static function is_admin_record(?array $user): bool {
        return $user !== null && ($user['type'] ?? 'standard') !== 'anon' && in_array('admin', (array) ($user['roles'] ?? []), true);
    }

    // Accepts password_hash() hashes (bcrypt/argon2) and, for backwards compatibility, the
    // legacy unsalted hex SHA-512 format. Comparisons are constant-time.
    public static function verify_password(string $pass, string $hash): bool {
        if (preg_match('/^[0-9a-f]{128}$/i', $hash)) {
            return hash_equals(strtolower($hash), hash('sha512', $pass));
        }
        return password_verify($pass, $hash);
    }

    private function start_user_session(string $name, int $version, bool $bootstrap): void {
        $this->session->regenerate();
        $this->session->set('USER', $name);
        $this->session->set('USER_VER', $version);
        $this->session->set('BOOTSTRAP', $bootstrap);
        $this->session->set('LOGIN_AT', time());
        $this->session->set('CSRF', bin2hex(random_bytes(32)));
        $this->user_resolved = false;
        $this->acl = null;
    }

    public function login(string $name, string $pass): bool {
        $store = $this->get_auth_store();
        $user = $name === '' ? null : $store->get_user($name);

        if ($user === null && ($name === '' || $name === 'admin') && $this->is_bootstrap_possible()) {
            if (!Context::verify_password($pass, $this->passhash)) {
                return false;
            }
            $this->start_user_session('admin', 0, true);
            return true;
        }

        // in anonymous mode other accounts fail like a wrong password (no hint which names exist)
        if ($this->is_anonymous_mode() && !Context::is_admin_record($user)) {
            $user = null;
        }
        $hash = is_string($user['hash'] ?? null) ? $user['hash'] : Context::DUMMY_HASH;
        $ok = password_verify($pass, $hash) && $user !== null && empty($user['disabled']);
        if (!$ok) {
            return false;
        }

        if ($store->is_writable()) {
            try {
                $store->update(function ($data) use ($name, $pass, $hash) {
                    if (isset($data['users'][$name])) {
                        $data['users'][$name]['lastLogin'] = time();
                        if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
                            $data['users'][$name]['hash'] = password_hash($pass, PASSWORD_DEFAULT);
                        }
                    }
                    return $data;
                });
            } catch (Throwable $err) {
                Logger::log('could not record login: ' . $err->getMessage());
            }
        }
        $this->start_user_session($name, (int) ($user['version'] ?? 0), false);
        return true;
    }

    public function logout(): void {
        $this->session->destroy();
        $this->user = null;
        $this->user_resolved = true;
        $this->acl = null;
    }

    // The logged in user as ['name' => string, 'roles' => string[], 'bootstrap' => bool], or null.
    // Sessions die when the user is deleted/disabled, their password or roles change (version
    // bump), or after security.sessionMaxAge seconds.
    public function get_user(): ?array {
        if ($this->user_resolved) {
            return $this->user;
        }
        $this->user_resolved = true;
        $this->user = null;

        $name = $this->session->get('USER');
        if (!is_string($name) || $name === '') {
            return null;
        }
        $max_age = (int) $this->query_option('security.sessionMaxAge', Context::DEFAULT_SESSION_MAX_AGE);
        if (time() - (int) $this->session->get('LOGIN_AT', 0) > max(60, $max_age)) {
            return null;
        }

        if ($this->session->get('BOOTSTRAP') === true) {
            if ($name === 'admin' && $this->is_bootstrap_possible()) {
                $this->user = ['name' => 'admin', 'roles' => ['admin'], 'bootstrap' => true, 'type' => 'standard'];
            }
            return $this->user;
        }

        $record = $this->get_auth_store()->get_user($name);
        if ($record === null || !empty($record['disabled']) || (int) ($record['version'] ?? 0) !== (int) $this->session->get('USER_VER', -1)) {
            return null;
        }
        // sessions of other accounts count as visitors while anonymous mode is on
        if ($this->is_anonymous_mode() && !Context::is_admin_record($record)) {
            return null;
        }
        $type = ($record['type'] ?? 'standard') === 'anon' ? 'anon' : 'standard';
        // anon accounts never carry roles (they'd widen access)
        $roles = $type === 'anon' ? [] : array_values(array_filter((array) ($record['roles'] ?? []), 'is_string'));
        $this->user = ['name' => $name, 'roles' => $roles, 'bootstrap' => false, 'type' => $type];
        return $this->user;
    }

    public function is_admin(): bool {
        $user = $this->get_user();
        return $user !== null && in_array('admin', $user['roles'], true);
    }

    public function check_csrf(mixed $token): bool {
        $expected = $this->session->get('CSRF');
        return is_string($expected) && is_string($token) && $expected !== '' && hash_equals($expected, $token);
    }

    public function get_csrf(): ?string {
        $token = $this->get_user() !== null ? $this->session->get('CSRF') : null;
        return is_string($token) ? $token : null;
    }

    // ---- permissions ---------------------------------------------------------------------

    public function get_acl(): Acl {
        if ($this->acl === null) {
            $user = $this->get_user();
            $this->acl = new Acl(
                $this->get_auth_store()->get_effective_rules(),
                $user['name'] ?? null,
                $user['roles'] ?? [],
                ($user['type'] ?? 'standard') === 'anon'
            );
        }
        return $this->acl;
    }

    // Root relative, decoded folder path as used by permission rules, e.g. "/team/docs/".
    public function to_rel_path(string $path): string {
        return Acl::normalize_path(substr($path, strlen($this->setup->get('ROOT_PATH'))));
    }

    public function level(string $dir_path): int {
        return $this->get_acl()->level($this->to_rel_path($dir_path));
    }

    public function can(string $dir_path, int $level): bool {
        return $this->level($dir_path) >= $level;
    }

    public function is_reachable(string $dir_path): bool {
        return $this->get_acl()->is_reachable($this->to_rel_path($dir_path));
    }

    // ---- request kind --------------------------------------------------------------------

    public function is_api_request(): bool {
        return strtolower($this->setup->get('REQUEST_METHOD')) === 'post';
    }

    public function is_info_request(): bool {
        return Util::starts_with($this->setup->get('REQUEST_HREF') . '/', $this->setup->get('PUBLIC_HREF'));
    }

    public function is_text_browser(): bool {
        return preg_match('/curl|elinks|links|lynx|w3m|wget/i', $this->setup->get('HTTP_USER_AGENT')) === 1;
    }

    public function is_fallback_mode(): bool {
        return $this->query_option('view.fallbackMode', false) === true || $this->is_text_browser();
    }

    // ---- paths ---------------------------------------------------------------------------

    public function to_href(string $path, bool $trailing_slash = true): string {
        $rel_path = substr($path, strlen($this->setup->get('ROOT_PATH')));
        $encoded_parts = [];
        foreach (explode('/', $rel_path) as $part) {
            if ($part !== '') {
                $encoded_parts[] = rawurlencode($part);
            }
        }

        return Util::normalize_path($this->setup->get('ROOT_HREF') . implode('/', $encoded_parts), $trailing_slash);
    }

    // Maps a client supplied href to a filesystem path below ROOT_PATH. Returns null for
    // anything that isn't a plain path inside the root: hrefs outside ROOT_HREF, dot segments
    // (also percent-encoded ones), NUL bytes, non-strings and paths into an old _h5ai folder.
    public function to_path(mixed $href): ?string {
        if (!is_string($href) || $href === '') {
            return null;
        }

        return $this->decoded_to_path(rawurldecode($href));
    }

    // Same as to_path() for an already percent-decoded path (e.g. nginx's $uri).
    public function decoded_to_path(string $decoded): ?string {
        if ($decoded === '' || str_contains($decoded, "\0")) {
            return null;
        }
        $decoded = Util::normalize_path($decoded, true);

        $root_href = $this->setup->get('ROOT_HREF');
        if (!Util::starts_with($decoded, $root_href)) {
            return null;
        }

        $segments = [];
        foreach (explode('/', substr($decoded, strlen($root_href))) as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }
            if ($segment === '..' || Context::is_h5ai_folder($segment)) {
                return null;
            }
            $segments[] = $segment;
        }

        return Util::normalize_path($this->setup->get('ROOT_PATH') . '/' . implode('/', $segments));
    }

    // h5ai's install folder, left in the files folder after a move to h6ai (the old web root often
    // becomes the files folder). Its private/conf/options.json holds h5ai's password hash. It's
    // never listed, searched, archived or served, whatever view.hidden says; "_h5ai.*" files
    // (h5ai's header and footer customisations) aren't affected.
    public static function is_h5ai_folder(string $name): bool {
        return strcasecmp($name, '_h5ai') === 0;
    }

    public function is_hidden(string $name): bool {
        // always hide
        if ($name === '.' || $name === '..' || Context::is_h5ai_folder($name)) {
            return true;
        }

        foreach ($this->query_option('view.hidden', []) as $re) {
            if (is_string($re) && @preg_match(Util::wrap_pattern($re), $name) === 1) {
                return true;
            }
        }

        return false;
    }

    // True if the path or any of its ancestors below ROOT_PATH is hidden, either by name
    // or by href (view.hidden patterns may match against both).
    public function is_hidden_path(string $path): bool {
        $root_path = $this->setup->get('ROOT_PATH');
        while ($path !== $root_path && Util::starts_with($path, $root_path)) {
            $parent = Util::normalize_path(dirname($path));
            if ($this->is_hidden(basename($path)) || $this->is_hidden($this->to_href($parent) . basename($path))) {
                return true;
            }
            if ($parent === $path) {
                break;
            }
            $path = $parent;
        }
        return false;
    }

    // Visible entries of a folder. With permission rules in place, files are only listed with at
    // least "list" access to the folder and subfolders only if they are reachable.
    public function read_dir(string $path): array {
        $names = [];
        if (!is_dir($path)) {
            return $names;
        }
        $acl_enabled = $this->get_acl()->is_enabled();
        $can_list = !$acl_enabled || $this->can($path, Acl::LIST);
        $href = $this->to_href($path);
        // bounded, so a folder with millions of entries can't exhaust memory
        $max = max(100, (int) $this->query_option('view.maxEntries', 20000));
        foreach (@scandir($path) ?: [] as $name) {
            if (count($names) >= $max) {
                break;
            }
            $child = $path . '/' . $name;
            if (
                $this->is_hidden($name)
                || $this->is_hidden($href . $name)
                || (!is_readable($child) && $this->query_option('view.hideIf403', false))
            ) {
                continue;
            }
            if ($acl_enabled) {
                $is_dir = is_dir($child);
                if ((!$is_dir && !$can_list) || ($is_dir && !$this->is_reachable($child))) {
                    continue;
                }
            }
            $names[] = $name;
        }
        return $names;
    }

    public function is_managed_href(mixed $href): bool {
        $path = $this->to_path($href);
        return $path !== null && $this->is_managed_path($path);
    }

    public function is_managed_path(string $path): bool {
        $root_path = $this->setup->get('ROOT_PATH');
        $path = Util::normalize_path($path);

        if (!is_dir($path) || !($path === $root_path || Util::starts_with($path, $root_path . '/'))) {
            return false;
        }

        foreach (explode('/', $path) as $segment) {
            if ($segment === '..' || $segment === '.') {
                return false;
            }
        }

        if (Util::starts_with($path . '/', $this->setup->get('H6AI_PATH') . '/')) {
            return false;
        }

        if ($this->is_hidden_path($path)) {
            return false;
        }

        foreach ($this->query_option('view.unmanaged', []) as $name) {
            if (is_string($name) && file_exists($path . '/' . $name)) {
                return false;
            }
        }

        while ($path !== $root_path) {
            if (@is_dir($path . '/_h6ai/private/conf')) {
                return false;
            }
            $parent_path = Util::normalize_path(dirname($path));
            if ($parent_path === $path) {
                return false;
            }
            $path = $parent_path;
        }
        return true;
    }

    // A file that may be exposed through the API: inside a managed folder, not hidden and
    // readable for the current user.
    public function is_exposed_file(string $path, int $level = Acl::READ): bool {
        return is_file($path)
            && $this->is_managed_path(dirname($path))
            && $this->can(dirname($path), $level)
            && !$this->is_hidden(basename($path))
            && !$this->is_hidden($this->to_href(dirname($path)) . basename($path));
    }

    public function get_current_path(): string {
        $current_path = $this->to_path(Util::normalize_path($this->setup->get('REQUEST_HREF'), true));
        if ($current_path === null) {
            return $this->setup->get('ROOT_PATH');
        }

        if (!is_dir($current_path)) {
            $current_path = Util::normalize_path(dirname($current_path), false);
        }

        return $current_path;
    }

    // ---- api data ------------------------------------------------------------------------

    public function get_items(mixed $href, int $what): array {
        if (!$this->is_managed_href($href)) {
            return [];
        }
        $cache = [];
        $folder = Item::get($this, $this->to_path($href), $cache);

        // folders the user can neither list nor navigate through don't exist for them: answer
        // with the (reachable) parent chain only, so the client can still render crumbs and tree
        if ($folder !== null && $this->get_acl()->is_enabled() && !$this->is_reachable($folder->path)) {
            $cache = [];
            $folder = $folder->get_parent($cache);
            $what = min($what, 1);
        }

        // add content of subfolders
        if ($what >= 2 && $folder !== null) {
            foreach ($folder->get_content($cache) as $item) {
                $item->get_content($cache);
            }
            $folder = $folder->get_parent($cache);
        }

        // add content of this folder and all parent folders
        while ($what >= 1 && $folder !== null) {
            $folder->get_content($cache);
            $folder = $folder->get_parent($cache);
        }

        uasort($cache, ['Item', 'cmp']);
        $result = [];
        foreach ($cache as $item) {
            $result[] = $item->to_json_object();
        }

        return $result;
    }

    public function get_langs(): array {
        $langs = [];
        $l10n_path = $this->setup->get('CONF_PATH') . '/l10n';
        foreach (Context::L10N_ISO_CODES as $iso_code) {
            $translations = Json::load($l10n_path . '/' . $iso_code . '.json');
            if (is_array($translations) && isset($translations['lang'])) {
                $langs[$iso_code] = $translations['lang'];
            }
        }
        ksort($langs);
        return $langs;
    }

    public function get_l10n(array $iso_codes): array {
        $results = [];

        foreach ($iso_codes as $iso_code) {
            if (!is_string($iso_code) || !in_array($iso_code, Context::L10N_ISO_CODES, true)) {
                continue;
            }

            $file = $this->setup->get('CONF_PATH') . '/l10n/' . $iso_code . '.json';
            $results[$iso_code] = Json::load($file) ?? [];
            $results[$iso_code]['isoCode'] = $iso_code;
        }

        return $results;
    }

    public function get_thumbs(array $requests): array {
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'too many thumbnail requests', count($requests) > Context::MAX_THUMB_REQUESTS);

        $thumb = new Thumb($this);
        $hrefs = [];
        foreach ($requests as $req) {
            $hrefs[] = is_array($req)
                ? $thumb->thumb($req['type'] ?? null, $req['href'] ?? null, $req['width'] ?? null, $req['height'] ?? null)
                : null;
        }
        return $hrefs;
    }

    // Per installation secret, e.g. to make thumbnail names unguessable. Stored guarded
    // (secret.key.php); a plain secret.key from an older version is moved over.
    public function get_secret(): string {
        foreach ([$this->setup->get('DATA_PATH'), $this->setup->get('CACHE_PRV_PATH')] as $dir) {
            $file = $dir . '/secret.key.php';
            $raw = @file_get_contents($file);
            $secret = is_string($raw) ? trim(Json::unguard($raw)) : '';
            if (strlen($secret) >= 32) {
                return $secret;
            }
            $legacy = @file_get_contents($dir . '/secret.key');
            $secret = is_string($legacy) && strlen(trim($legacy)) >= 32 ? trim($legacy) : bin2hex(random_bytes(32));
            if (is_dir($dir) && is_writable($dir) && Json::write_guarded($file, $secret)) {
                @unlink($dir . '/secret.key');
                return $secret;
            }
            if (is_string($legacy) && strlen(trim($legacy)) >= 32) {
                return trim($legacy);
            }
        }
        return hash('sha256', $this->setup->get('H6AI_PATH') . php_uname() . $this->passhash);
    }

    // ---- page head -----------------------------------------------------------------------

    private function prefix_x_head_href(string $href): string {
        if (preg_match('@^(https?:)?//|^/@i', $href)) {
            return $href;
        }

        return $this->setup->get('PUBLIC_HREF') . 'ext/' . $href;
    }

    private function get_fonts_html(string $nonce): string {
        $quote = fn ($font) => '"' . str_replace(['"', '\\', '<', '>', ';', '{', '}'], '', (string) $font) . '"';
        $fonts = array_map($quote, array_filter((array) $this->query_option('view.fonts', []), 'is_string'));
        $fonts_mono = array_map($quote, array_filter((array) $this->query_option('view.fontsMono', []), 'is_string'));

        $css = '';
        if ($fonts) {
            $css .= ':root{--font-sans:' . implode(',', $fonts) . '}';
        }
        if ($fonts_mono) {
            $css .= ':root{--font-mono:' . implode(',', $fonts_mono) . '}';
        }

        return $css === '' ? '' : '<style class="x-head" nonce="' . Util::html($nonce) . '">' . $css . '</style>';
    }

    private function get_resources(string $kind): array {
        return array_values(array_filter((array) $this->query_option('resources.' . $kind, []), 'is_string'));
    }

    // Search Console verification, robots and Google Analytics / Tag Manager loaders.
    public function get_head_meta_html(string $nonce, bool $is_info): string {
        $settings = $this->get_settings();
        $html = '';

        $verification = $settings->get('google.verification');
        if ($verification !== '') {
            $html .= '<meta name="google-site-verification" content="' . Util::html($verification) . '">';
        }
        $index = !$is_info && $settings->get('seo.allowIndexing') === true;
        $html .= '<meta name="robots" content="' . ($index ? 'index, follow' : 'noindex, nofollow') . '">';

        if ($is_info) {
            return $html; // no tracking on the admin page
        }

        $n = Util::html($nonce);
        $gtm = $settings->get('google.tagManagerId');
        if ($gtm !== '') {
            $html .= '<script nonce="' . $n . '">(function(w,d,s,l,i,n){w[l]=w[l]||[];w[l].push({"gtm.start":new Date().getTime(),event:"gtm.js"});'
                . 'var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!="dataLayer"?"&l="+l:"";j.async=true;j.nonce=n;'
                . 'j.src="https://www.googletagmanager.com/gtm.js?id="+i+dl;f.parentNode.insertBefore(j,f);})'
                . '(window,document,"script","dataLayer",' . json_encode($gtm) . ',' . json_encode($nonce) . ');</script>';
        }
        $ga = $settings->get('google.measurementId');
        if ($ga !== '') {
            $config = ['send_page_view' => true];
            $user_id = (new Analytics($this))->user_id();
            if ($user_id !== null) {
                $config['user_id'] = $user_id;
            }
            $html .= '<script async nonce="' . $n . '" src="https://www.googletagmanager.com/gtag/js?id=' . rawurlencode($ga) . '"></script>'
                . '<script nonce="' . $n . '">window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}'
                . 'gtag("js",new Date());gtag("config",' . json_encode($ga) . ',' . json_encode($config, JSON_UNESCAPED_SLASHES) . ');</script>';
        }
        return $html;
    }

    public function get_x_head_html(string $nonce): string {
        $html = '';

        foreach ($this->get_resources('styles') as $href) {
            $html .= '<link rel="stylesheet" href="' . Util::html($this->prefix_x_head_href($href)) . '" class="x-head">';
        }

        foreach ($this->get_resources('scripts') as $href) {
            $html .= '<script src="' . Util::html($this->prefix_x_head_href($href)) . '" class="x-head"></script>';
        }

        $html .= $this->get_fonts_html($nonce);

        return $html;
    }

    // ---- security headers ----------------------------------------------------------------

    private static function origin_of(string $href): ?string {
        if (preg_match('@^(https?:)?//([^/?#]+)@i', $href, $matches)) {
            return ($matches[1] ?: 'https:') . '//' . $matches[2];
        }
        return null;
    }

    public function get_csp(string $nonce): ?string {
        $option = $this->query_option('security.csp', true);
        if ($option === false) {
            return null;
        }
        if (is_string($option) && $option !== '') {
            return str_replace('{nonce}', $nonce, $option);
        }

        $script_src = ["'self'", "'nonce-$nonce'"];
        $style_src = ["'self'", "'nonce-$nonce'"];
        $img_src = ["'self'", 'data:', 'blob:', 'https:'];
        $connect_src = ["'self'"];
        $font_src = ["'self'", 'data:'];

        foreach ($this->get_resources('scripts') as $href) {
            if ($origin = Context::origin_of($href)) {
                $script_src[] = $origin;
            }
        }
        foreach ($this->get_resources('styles') as $href) {
            if ($origin = Context::origin_of($href)) {
                $style_src[] = $origin;
                $font_src[] = $origin;
            }
        }
        // stylesheets from Google Fonts load the font files from a second origin
        if (in_array('https://fonts.googleapis.com', $style_src, true)) {
            $font_src[] = 'https://fonts.gstatic.com';
        }

        $settings = $this->get_settings();
        $frame_src = [];
        if ($settings->has_google_analytics() || $settings->has_tag_manager()) {
            $script_src[] = 'https://www.googletagmanager.com';
            array_push($connect_src, 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com');
            $frame_src[] = 'https://www.googletagmanager.com';
        }
        if ($settings->has_tag_manager()) {
            // tags loaded by the (nonced) Tag Manager script may load further scripts
            $script_src[] = "'strict-dynamic'";
        }

        foreach (['matomo-analytics', 'piwik-analytics'] as $ext) {
            $base_url = $this->query_option($ext . '.baseURL', null);
            if ($this->query_option($ext . '.enabled', false) === true && is_string($base_url) && $base_url !== '') {
                $origin = Context::origin_of('//' . preg_replace('@^https?://@i', '', $base_url));
                if ($origin) {
                    $script_src[] = $origin;
                    $connect_src[] = $origin;
                    $img_src[] = $origin;
                }
            }
        }

        $directives = [
            "default-src 'self'",
            'script-src ' . implode(' ', array_unique($script_src)),
            'style-src ' . implode(' ', array_unique($style_src)),
            // inline style attributes are needed by user supplied header/footer HTML
            "style-src-attr 'unsafe-inline'",
            'img-src ' . implode(' ', array_unique($img_src)),
            "media-src 'self' blob:",
            'font-src ' . implode(' ', array_unique($font_src)),
            'connect-src ' . implode(' ', array_unique($connect_src)),
            'frame-src ' . ($frame_src ? implode(' ', $frame_src) : "'none'"),
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'self'"
        ];
        return implode('; ', $directives);
    }

    public function send_page_headers(string $nonce): void {
        header('Content-Type: text/html;charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: same-origin');
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        header('Cache-Control: no-cache');
        $csp = $this->get_csp($nonce);
        if ($csp !== null) {
            header('Content-Security-Policy: ' . $csp);
        }
    }
}

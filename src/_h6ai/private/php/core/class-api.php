<?php
declare(strict_types=1);

final class Api {
    private const ACTIONS = ['admin', 'download', 'get', 'login', 'logout', 'passhash', 'password'];

    private Request $request;
    private Setup $setup;

    public function __construct(private readonly Context $context) {
        $this->request = $context->get_request();
        $this->setup = $context->get_setup();
    }

    public function apply(): never {
        $action = $this->request->query('action');
        Util::json_fail(Util::ERR_UNSUPPORTED, 'unsupported action', !in_array($action, Api::ACTIONS, true));

        match ($action) {
            'admin' => $this->on_admin(),
            'download' => $this->on_download(),
            'password' => $this->on_password(),
            'get' => $this->on_get(),
            'login' => $this->on_login(),
            'logout' => $this->on_logout(),
            'passhash' => $this->on_passhash()
        };
    }

    // First run without a shell (drop-in installs): hashes a setup password for the admin to
    // save as private/conf/options.local.json by hand. Saving that file proves the admin owns the
    // server, so h6ai never stores it itself. Only while no password or user exists at all.
    private function on_passhash(): never {
        $this->require_same_origin();
        Util::json_fail(Util::ERR_DISABLED, 'a password or users already exist', $this->context->has_password());
        $limiter = new RateLimiter(
            $this->setup->get('CACHE_PRV_PATH'),
            $this->request->client_ip(),
            max(1, (int) $this->context->query_option('security.loginMaxAttempts', 5)),
            max(1, (int) $this->context->query_option('security.loginWindow', 900))
        );
        Util::json_fail(Util::ERR_RATE_LIMITED, 'too many requests, try again later', $limiter->is_limited());
        $limiter->hit();
        $pass = $this->request->query('pass');
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'the password needs at least 8 characters',
            !is_string($pass) || mb_strlen($pass) < 8 || strlen($pass) > 1024);
        $local = ['passhash' => password_hash($pass, PASSWORD_DEFAULT)];

        // drop-in: the folder to share, outside the web root
        $folder = $this->request->query('filesFolder', '');
        $check = null;
        if (is_string($folder) && trim($folder) !== '') {
            $folder = rtrim(trim($folder), '/');
            Util::json_fail(Util::ERR_ILLEGAL_PARAM, 'the files folder must be an absolute path, e.g. /srv/files',
                !str_starts_with($folder, '/') || str_contains($folder, "\0") || strlen($folder) > 1024);
            $real = realpath($folder) ?: $folder;
            $web_root = (string) $this->setup->get('DOCUMENT_ROOT');
            $check = [
                'exists' => is_dir($real),
                'readable' => is_dir($real) && is_readable($real) && @scandir($real) !== false,
                'insideWebRoot' => $web_root !== '' && ($real === $web_root || str_starts_with($real . '/', $web_root . '/'))
            ];
            $local['filesFolder'] = $folder;
        }
        $json = json_encode($local, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        // options.local.php: the guard line keeps it unreadable if requested over HTTP
        Util::json_exit(['passhash' => $local['passhash'], 'file' => Json::GUARD . $json . "\n", 'folder' => $check]);
    }

    private function on_download(): never {
        Util::json_fail(Util::ERR_DISABLED, 'download disabled', $this->context->query_option('download.enabled', false) !== true);

        $as = $this->request->query('as', 'download.tar');
        $type = $this->request->query_string('type');
        $base_href = $this->request->query('baseHref');
        $hrefs = $this->request->query('hrefs', []);

        $configured_type = $this->context->query_option('download.type', 'php-tar');
        Util::json_fail(Util::ERR_FORBIDDEN, 'download type not enabled', $type !== $configured_type);

        $base_path = $this->context->to_path($base_href);
        Util::json_fail(Util::ERR_FORBIDDEN, 'no download permission',
            $base_path !== null && !$this->context->can($base_path, Acl::DOWNLOAD));

        $archive = new Archive($this->context);
        $error = $archive->prepare($type, $base_href, $hrefs);
        Util::json_fail(Util::ERR_ILLEGAL_PARAM, (string) $error, $error !== null);

        $base = is_string($base_href) ? rawurldecode($base_href) : '';
        (new ActivityLog($this->context))->log('archive', $base, [
            'type' => $type,
            'items' => is_array($hrefs) ? count(array_filter($hrefs, fn ($h) => is_string($h) && trim($h) !== '')) : 0
        ]);

        $this->context->get_session()->close();
        // lets the page switch its "Preparing…" state once the stream actually starts
        $token = $this->request->query('token', null);
        if (is_string($token) && preg_match('/^[a-z0-9]{8,32}$/', $token)) {
            setcookie('h6ai_dl_' . $token, '1', ['expires' => time() + 120, 'path' => '/', 'samesite' => 'Strict', 'secure' => $this->request->is_https()]);
        }
        $archive->send(is_string($as) ? $as : 'download');
        if (!connection_aborted() && is_string($base_href)) {
            (new Analytics($this->context))->download('archive', $base_href, (new Seo($this->context))->base_url());
        }
        exit;
    }

    private function on_get(): never {
        $response = [];

        foreach (['langs', 'options', 'types'] as $name) {
            if ($this->request->query_boolean($name, false)) {
                $methodname = 'get_' . $name;
                $response[$name] = $this->context->$methodname();
            }
        }

        if ($this->request->query_boolean('setup', false)) {
            $is_admin = $this->context->is_admin();
            $user = $this->context->get_user();
            $response['setup'] = $this->setup->to_jsono($is_admin);
            $response['setup']['USER'] = $user === null ? null : [
                'name' => $user['name'],
                'roles' => $user['roles'],
                'type' => $user['type'] ?? 'standard',
                'isAdmin' => $is_admin,
                'bootstrap' => $user['bootstrap']
            ];
            $response['setup']['SITE'] = $this->context->get_settings()->to_public();
            $response['setup']['CSRF'] = $this->context->get_csrf();
            $response['setup']['AUTH'] = [
                'loginAvailable' => $this->context->has_password(),
                // no sign-in in the listing; the admin page still offers it to admins
                'anonymous' => $this->context->is_anonymous_mode(),
                // the first-run card asks for the files folder of a drop-in install
                'dropin' => $this->setup->get('IS_DROPIN'),
                'restricted' => $this->context->get_acl()->is_enabled()
            ];
            if ($is_admin) {
                $response['setup']['HAS_VALID_OPTIONS'] = $this->context->are_options_valid();
            }
        }

        if ($this->request->query_boolean('theme', false)) {
            $theme = new Theme($this->context);
            $response['theme'] = $theme->get_icons();
        }

        if ($this->request->query('items', false)) {
            $href = $this->request->query('items.href');
            $what = $this->request->query_numeric('items.what');
            $response['items'] = $this->context->get_items($href, $what);
            $path = $this->context->to_path($href);
            if ($path !== null && is_dir($path) && !$this->context->can($path, Acl::LIST)) {
                $response['denied'] = $this->context->get_user() !== null ? 'forbidden'
                    : ($this->context->is_anonymous_mode() ? 'unavailable' : 'login');
            }
        }

        if ($this->request->query('custom', false)) {
            Util::json_fail(Util::ERR_DISABLED, 'custom disabled', $this->context->query_option('custom.enabled', false) !== true);
            $href = $this->request->query('custom');
            $custom = new Custom($this->context);
            $response['custom'] = $custom->get_customizations($href);
        }

        if ($this->request->query('l10n', false)) {
            Util::json_fail(Util::ERR_DISABLED, 'l10n disabled', $this->context->query_option('l10n.enabled', false) !== true);
            $iso_codes = array_filter($this->request->query_array('l10n'));
            $response['l10n'] = $this->context->get_l10n($iso_codes);
        }

        if ($this->request->query('search', false)) {
            Util::json_fail(Util::ERR_DISABLED, 'search disabled', $this->context->query_option('search.enabled', false) !== true);
            $href = $this->request->query('search.href');
            $pattern = $this->request->query_string('search.pattern');
            $ignorecase = $this->request->query_boolean('search.ignorecase', false);
            $search = new Search($this->context);
            $response['search'] = $search->get_items($href, $pattern, $ignorecase);
        }

        if ($this->request->query('thumbs', false)) {
            Util::json_fail(Util::ERR_DISABLED, 'thumbnails disabled', $this->context->query_option('thumbnails.enabled', false) !== true);
            Util::json_fail(Util::ERR_UNSUPPORTED, 'thumbnails not supported', !$this->setup->get('HAS_PHP_JPEG'));
            $thumbs = $this->request->query_array('thumbs');
            $response['thumbs'] = $this->context->get_thumbs($thumbs);
        }

        Util::json_exit($response);
    }

    private function require_same_origin(): void {
        Util::json_fail(Util::ERR_FORBIDDEN, 'cross-origin request rejected', !$this->request->is_same_origin());
    }

    private function on_login(): never {
        $this->require_same_origin();
        Util::json_fail(Util::ERR_DISABLED, 'login disabled, no users or password configured', !$this->context->has_password());

        $limiter = new RateLimiter(
            $this->setup->get('CACHE_PRV_PATH'),
            $this->request->client_ip(),
            max(1, (int) $this->context->query_option('security.loginMaxAttempts', 5)),
            max(1, (int) $this->context->query_option('security.loginWindow', 900))
        );
        Util::json_fail(Util::ERR_RATE_LIMITED, 'too many failed login attempts, try again later', $limiter->is_limited());

        $name = $this->request->query('user', '');
        $pass = $this->request->query('pass');
        $ok = is_string($name) && is_string($pass) && strlen($pass) <= 1024 && $this->context->login(trim($name), $pass);
        $log = new ActivityLog($this->context);
        if ($ok) {
            $limiter->reset();
            $log->log('login', null);
        } else {
            $limiter->hit();
            $log->log('login-failed', null, ['attempted' => is_string($name) ? mb_substr($name, 0, 64) : null]);
            usleep(random_int(200000, 400000));
        }
        $user = $this->context->get_user();
        Util::json_exit(['asAdmin' => $ok && $this->context->is_admin(), 'user' => $ok && $user ? $user['name'] : null]);
    }

    private function require_session_token(): void {
        $this->require_same_origin();
        Util::json_fail(Util::ERR_FORBIDDEN, 'invalid or missing csrf token', !$this->context->check_csrf($this->request->query('csrf', null)));
    }

    private function on_logout(): never {
        $this->require_same_origin();
        // a stale/missing token only matters if there is a live session to end
        if ($this->context->get_user() !== null) {
            $this->require_session_token();
        }
        $this->context->logout();
        Util::json_exit(['asAdmin' => false, 'user' => null]);
    }

    private function on_password(): never {
        $this->require_session_token();
        $user = $this->context->get_user();
        Util::json_fail(Util::ERR_FORBIDDEN, 'this account can not change its password', $user === null || $user['bootstrap'] || ($user['type'] ?? '') === 'anon');
        $admin = new Admin($this->context);
        try {
            $ok = $admin->change_own_password($this->request->query_string('current'), $this->request->query_string('new'));
        } catch (InvalidArgumentException $err) {
            Util::json_exit(['err' => Util::ERR_ILLEGAL_PARAM, 'msg' => $err->getMessage()], 400);
        }
        Util::json_fail(Util::ERR_FORBIDDEN, 'current password is wrong', !$ok);
        Util::json_exit(['ok' => true]);
    }

    private function on_admin(): never {
        $this->require_session_token();
        Util::json_fail(Util::ERR_FORBIDDEN, 'admin only', !$this->context->is_admin());
        $admin = new Admin($this->context);
        Util::json_exit($admin->apply($this->request->query_string('op'), $this->request));
    }
}

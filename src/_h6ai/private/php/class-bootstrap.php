<?php
declare(strict_types=1);

// requested directly over HTTP (drop-in installs let PHP run every .php file): nothing to see
if (!defined('H6AI_VERSION') && PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

final class Bootstrap {
    private const AUTOPATHS = ['core', 'ext'];

    public static function run(): void {
        spl_autoload_register([Bootstrap::class, 'autoload']);
        putenv('LANG=en_US.UTF-8');
        setlocale(LC_CTYPE, 'en_US.UTF-8', 'C.UTF-8');
        date_default_timezone_set(@date_default_timezone_get() ?: 'UTC');
        set_exception_handler([Bootstrap::class, 'on_exception']);
        // whatever the server's php.ini says (drop-in installs run on someone else's)
        ini_set('display_errors', '0');
        header_remove('X-Powered-By');

        // h6ai never takes multipart bodies or other methods (CVE-2026-109618). h6ai's nginx
        // snippet refuses them before PHP; on a drop-in install this is the place.
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
            http_response_code(405);
            exit;
        }
        if (str_starts_with(strtolower(trim((string) ($_SERVER['CONTENT_TYPE'] ?? ''))), 'multipart/')) {
            http_response_code(415);
            exit;
        }

        $request = Request::from_globals();
        $setup = new Setup(false);
        // reverse proxy settings first: they decide the client address and whether cookies are Secure
        $settings = new Settings($setup->get('DATA_PATH'), $setup->get('CACHE_PRV_PATH'));
        $request->configure_proxy((array) $settings->get('proxy.trusted', []), (string) $settings->get('proxy.publicUrl', ''));
        $session = new Session($request->is_https());
        $is_admin_refresh = $request->query('refresh', false) !== false && $request->query_boolean('refresh', false);
        $context = new Context($session, $request, $setup);
        if ($is_admin_refresh && $context->is_admin()) {
            // re-detect available shell commands, only on request of a logged in admin
            $setup = new Setup(true);
            $context = new Context($session, $request, $setup);
        }

        if (($_SERVER['H6AI_GATE'] ?? null) === 'check') {
            (new Gate($context))->check();
        }

        // search engine files, unless the shared folder has real ones
        if (!$context->is_api_request()) {
            $route = substr($setup->get('REQUEST_HREF'), strlen($setup->get('ROOT_HREF')));
            $real = in_array($route, ['robots.txt', 'sitemap.xml'], true) && is_file($setup->get('ROOT_PATH') . '/' . $route);
            if ($route === 'robots.txt' && !$real) {
                (new Seo($context))->robots();
            }
            if ($route === 'sitemap.xml' && !$real) {
                (new Seo($context))->sitemap();
            }
        }

        // drop-in installs: h6ai serves the shared folder itself (FileServer)
        if ($setup->get('IS_DROPIN') && !$context->is_api_request()) {
            $file_server = new FileServer($context);
            if (!$context->is_info_request()) {
                $file_server->route();
            } elseif (str_starts_with((string) $setup->get('REQUEST_HREF'), (string) $setup->get('PUBLIC_HREF') . 'v/')) {
                $file_server->asset();
            } elseif (($_GET['h6ai-probe'] ?? null) === 'accel') {
                $file_server->probe();
            }
        }

        // search index work on installs without the CLI indexer, after the response is sent
        register_shutdown_function([SearchIndexer::class, 'tick'], $context);

        if ($context->is_api_request()) {
            (new Api($context))->apply();
        }

        $nonce = base64_encode(random_bytes(18));

        $is_info = $context->is_info_request();
        $page = [
            'module' => $is_info ? 'info' : 'index',
            'title' => $is_info ? $context->get_settings()->get('siteName') . ' admin' : $context->get_settings()->get('siteName'),
            'site_name' => $context->get_settings()->get('siteName'),
            'head_meta' => $context->get_head_meta_html($nonce, $is_info),
            'version' => $setup->get('VERSION'),
            'public_href' => $setup->get('PUBLIC_HREF'),
            'asset_href' => $setup->get('ASSET_HREF'),
            'index_href' => $setup->get('INDEX_HREF'),
            'nonce' => $nonce,
            'skin' => $context->get_settings()->get('appearance.theme'),
            'skins' => Settings::THEMES,
            'x_head_tags' => $context->get_x_head_html($nonce),
            'fallback_mode' => !$is_info && $context->is_fallback_mode(),
            'fallback_html' => $is_info ? '' : (new Fallback($context))->get_html(),
            'external_user' => Bootstrap::get_external_user($context)
        ];

        $context->send_page_headers($nonce);
        Bootstrap::render(__DIR__ . '/pages/page.php', $page);
    }

    // External user from FastCGI params (set by the web server, never from HTTP_* headers).
    private static function get_external_user(Context $context): ?array {
        $opts = [
            'enabled' => $context->query_option('auth.external.enabled', false),
            'logoutUrl' => $context->query_option('auth.external.logoutUrl', ''),
            'label' => $context->query_option('auth.external.label', ''),
        ];
        return Bootstrap::resolve_external_user($opts);
    }

    // Returns null or ['name' => string, 'auth' => 'session'|'basic', 'logoutUrl' => string, 'label' => string].
    // Reads H6AI_EXTERNAL_USER / H6AI_EXTERNAL_AUTH from $_SERVER (FastCGI params, never HTTP_*).
    public static function resolve_external_user(array $opts): ?array {
        if (($opts['enabled'] ?? false) !== true) {
            return null;
        }
        $raw = $_SERVER['H6AI_EXTERNAL_USER'] ?? '';
        if (!is_string($raw)) {
            return null;
        }
        $clean = preg_replace('/[\x00-\x1f\x7f]/', '', $raw);
        $name = mb_substr(trim(mb_convert_encoding($clean, 'UTF-8', 'UTF-8')), 0, 100);
        if ($name === '') {
            return null;
        }

        $auth_raw = $_SERVER['H6AI_EXTERNAL_AUTH'] ?? '';
        $auth = is_string($auth_raw) && strtolower(trim($auth_raw)) === 'basic' ? 'basic' : 'session';

        $logout_url = Bootstrap::validate_logout_url($opts['logoutUrl'] ?? '');
        $label = (string) ($opts['label'] ?? '');

        return ['name' => $name, 'auth' => $auth, 'logoutUrl' => $logout_url, 'label' => $label];
    }

    // Same-origin path: /path (not //, /\, backslash anywhere, control chars, whitespace, >1024).
    public static function validate_logout_url(mixed $raw): string {
        if (!is_string($raw) || $raw === '') {
            return '';
        }
        if (strlen($raw) > 1024 || !preg_match('#^/(?![/\\\\])[^\\\\\x00-\x20\x7f]*$#', $raw)) {
            Logger::log('auth.external.logoutUrl rejected: must be a same-origin path starting with /, no backslashes or control characters');
            return '';
        }
        return $raw;
    }

    private static function render(string $template, array $page): void {
        require $template;
    }

    public static function on_exception(Throwable $err): void {
        Logger::log('uncaught ' . get_class($err) . ': ' . $err->getMessage() . ' @ ' . $err->getFile() . ':' . $err->getLine());
        if (!headers_sent() && strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            Util::json_exit(['err' => Util::ERR_FAILED, 'msg' => 'internal error'], 500);
        }
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: text/plain;charset=utf-8');
        }
        echo 'h6ai: internal error, see the web server error log for details';
    }

    public static function autoload(string $class_name): bool {
        $filename = 'class-' . strtolower($class_name) . '.php';

        foreach (Bootstrap::AUTOPATHS as $path) {
            $file = __DIR__ . '/' . $path . '/' . $filename;
            if (file_exists($file)) {
                require_once $file;
                return true;
            }
        }
        return false;
    }
}

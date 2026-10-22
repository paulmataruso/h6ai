<?php
declare(strict_types=1);

final class Bootstrap {
    private const AUTOPATHS = ['core', 'ext'];

    public static function run(): void {
        spl_autoload_register([Bootstrap::class, 'autoload']);
        putenv('LANG=en_US.UTF-8');
        setlocale(LC_CTYPE, 'en_US.UTF-8', 'C.UTF-8');
        date_default_timezone_set(@date_default_timezone_get() ?: 'UTC');
        set_exception_handler([Bootstrap::class, 'on_exception']);

        $request = Request::from_globals();
        $session = new Session($request->is_https());
        $is_admin_refresh = $request->query('refresh', false) !== false && $request->query_boolean('refresh', false);
        $setup = new Setup(false);
        $context = new Context($session, $request, $setup);
        if ($is_admin_refresh && $context->is_admin()) {
            // re-detect available shell commands, only on request of a logged in admin
            $setup = new Setup(true);
            $context = new Context($session, $request, $setup);
        }

        if (($_SERVER['H6AI_GATE'] ?? null) === 'check') {
            (new Gate($context))->check();
        }

        // search engine files, routed here by nginx when no real file exists
        if (!$context->is_api_request()) {
            $route = substr($setup->get('REQUEST_HREF'), strlen($setup->get('ROOT_HREF')));
            if ($route === 'robots.txt') {
                (new Seo($context))->robots();
            }
            if ($route === 'sitemap.xml') {
                (new Seo($context))->sitemap();
            }
        }

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
            'nonce' => $nonce,
            'skin' => $context->get_settings()->get('appearance.theme'),
            'skins' => Settings::THEMES,
            'x_head_tags' => $context->get_x_head_html($nonce),
            'fallback_mode' => !$is_info && $context->is_fallback_mode(),
            'fallback_html' => $is_info ? '' : (new Fallback($context))->get_html()
        ];

        $context->send_page_headers($nonce);
        Bootstrap::render(__DIR__ . '/pages/page.php', $page);
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

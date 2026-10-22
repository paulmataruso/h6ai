<?php
declare(strict_types=1);

// robots.txt and sitemap.xml for search engines. Only content an anonymous visitor can access is
// listed; permissions and hidden patterns apply exactly as for guests.
final class Seo {
    private const MAX_URLS = 50000;
    private const MAX_DEPTH = 32;
    private const TIME_LIMIT = 20;
    private const CACHE_TTL = 3600;

    public function __construct(private readonly Context $context) {}

    public function base_url(): string {
        $request = $this->context->get_request();
        $host = (string) ($request->header('Host') ?? 'localhost');
        if (!preg_match('/^[A-Za-z0-9.\-:\[\]]{1,255}$/', $host)) {
            $host = 'localhost';
        }
        return ($request->is_https() ? 'https' : 'http') . '://' . $host;
    }

    public function robots(): never {
        $settings = $this->context->get_settings();
        $root = $this->context->get_setup()->get('ROOT_HREF');
        $public = $this->context->get_setup()->get('PUBLIC_HREF');
        $lines = ['User-agent: *'];
        if ($settings->get('seo.allowIndexing') === true) {
            $lines[] = 'Allow: ' . $root;
            // assets are needed to render pages, the admin page and internals are not
            foreach (['css/', 'js/', 'images/', 'cache/thumbs/'] as $dir) {
                $lines[] = 'Allow: ' . $public . $dir;
            }
            $lines[] = 'Disallow: ' . $root . '_h6ai/';
            if ($settings->get('seo.sitemap') === true) {
                $lines[] = '';
                $lines[] = 'Sitemap: ' . $this->base_url() . $root . 'sitemap.xml';
            }
        } else {
            $lines[] = 'Disallow: /';
        }
        header('Content-Type: text/plain;charset=utf-8');
        header('Cache-Control: public, max-age=3600');
        echo implode("\n", $lines), "\n";
        exit;
    }

    public function sitemap(): never {
        $settings = $this->context->get_settings();
        if ($settings->get('seo.allowIndexing') !== true || $settings->get('seo.sitemap') !== true) {
            http_response_code(404);
            header('Content-Type: text/plain;charset=utf-8');
            echo "sitemap disabled\n";
            exit;
        }

        $rules = $this->context->get_auth_store()->get_effective_rules();
        $base = $this->base_url();
        $cache_dir = $this->context->get_setup()->get('CACHE_PRV_PATH');
        $cache_file = $cache_dir . '/sitemap-' . sha1(json_encode($rules) . '|' . $base . '|' . json_encode($this->context->get_options()['view'] ?? [])) . '.xml';

        $mtime = @filemtime($cache_file);
        if ($mtime === false || $mtime < time() - Seo::CACHE_TTL) {
            $xml = $this->build($rules, $base);
            if (is_writable($cache_dir)) {
                $tmp = $cache_file . '.' . bin2hex(random_bytes(4)) . '.tmp';
                if (@file_put_contents($tmp, $xml) === false || !@rename($tmp, $cache_file)) {
                    @unlink($tmp);
                }
            }
        } else {
            $xml = (string) file_get_contents($cache_file);
        }

        header('Content-Type: application/xml;charset=utf-8');
        header('Cache-Control: public, max-age=3600');
        echo $xml;
        exit;
    }

    private function build(array $rules, string $base): string {
        $guest = new Acl($rules, null, []);
        $context = $this->context;
        $root_path = $context->get_setup()->get('ROOT_PATH');
        $deadline = microtime(true) + Seo::TIME_LIMIT;

        $urls = [];
        $add = function (string $path, bool $is_dir) use (&$urls, $context, $base) {
            $mtime = @filemtime($path);
            $urls[] = '<url><loc>' . Util::html($base . $context->to_href($path, $is_dir)) . '</loc>'
                . ($mtime ? '<lastmod>' . gmdate('Y-m-d\TH:i:s\Z', $mtime) . '</lastmod>' : '') . '</url>';
        };

        $visited = [];
        $queue = [[$root_path, 0]];
        while ($queue && count($urls) < Seo::MAX_URLS && microtime(true) < $deadline) {
            [$dir, $depth] = array_shift($queue);
            $real = realpath($dir);
            if ($real === false || isset($visited[$real])) {
                continue;
            }
            $visited[$real] = true;

            $rel = $context->to_rel_path($dir);
            $can_list = $guest->level($rel) >= Acl::LIST;
            if ($can_list) {
                $add($dir, true);
            }
            if (!$context->is_managed_path($dir)) {
                continue; // folder with its own index page: the folder URL is enough
            }
            $can_read = $guest->level($rel) >= Acl::READ;
            $href = $context->to_href($dir);
            foreach (@scandir($dir) ?: [] as $name) {
                if (count($urls) >= Seo::MAX_URLS) {
                    break;
                }
                if ($context->is_hidden($name) || $context->is_hidden($href . $name)) {
                    continue;
                }
                $path = $dir . '/' . $name;
                if (is_dir($path)) {
                    if ($depth < Seo::MAX_DEPTH && $guest->is_reachable($context->to_rel_path($path))) {
                        $queue[] = [$path, $depth + 1];
                    }
                } elseif ($can_read && is_file($path) && is_readable($path)) {
                    $add($path, false);
                }
            }
        }

        return '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
            . '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n"
            . implode("\n", $urls) . "\n</urlset>\n";
    }
}

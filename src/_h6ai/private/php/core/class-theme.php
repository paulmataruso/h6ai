<?php
declare(strict_types=1);

final class Theme {
    private const EXTENSIONS = ['svg', 'png', 'jpg', 'webp'];

    public function __construct(private readonly Context $context) {}

    public function get_icons(): array {
        $public_path = $this->context->get_setup()->get('PUBLIC_PATH');
        $theme = $this->context->query_option('view.theme', '-NONE-');
        if (!is_string($theme) || !preg_match('/^[\w.-]+$/', $theme) || str_starts_with($theme, '.')) {
            return [];
        }
        $theme_path = $public_path . '/images/themes/' . $theme;

        $icons = [];
        if (is_dir($theme_path) && ($dir = opendir($theme_path))) {
            while (($name = readdir($dir)) !== false) {
                $path_parts = pathinfo($name);
                if (in_array($path_parts['extension'] ?? '', Theme::EXTENSIONS, true)) {
                    $icons[$path_parts['filename']] = $theme . '/' . $name;
                }
            }
            closedir($dir);
        }

        return $icons;
    }
}

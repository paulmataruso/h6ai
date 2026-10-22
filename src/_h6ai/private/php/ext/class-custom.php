<?php
declare(strict_types=1);

final class Custom {
    private const EXTENSIONS = ['html', 'md'];
    private const MAX_BYTES = 1048576;

    public function __construct(private readonly Context $context) {}

    private function read_custom_file(string $path, string $name, ?string &$content, ?string &$type): void {
        // "_h5ai.*" files from installations before the rename to h6ai still work
        $prefixes = [$this->context->get_setup()->get('FILE_PREFIX'), '_h5ai'];

        foreach ($prefixes as $file_prefix) {
            foreach (Custom::EXTENSIONS as $ext) {
                $file = $path . '/' . $file_prefix . '.' . $name . '.' . $ext;
                if (is_file($file) && is_readable($file)) {
                    $data = @file_get_contents($file, false, null, 0, Custom::MAX_BYTES);
                    if ($data !== false) {
                        $content = $data;
                        $type = $ext;
                        return;
                    }
                }
            }
        }
    }

    public function get_customizations(mixed $href): array {
        $header = null;
        $header_type = null;
        $footer = null;
        $footer_type = null;

        $path = $this->context->to_path($href);
        if (
            $this->context->query_option('custom.enabled', false) !== true
            || $path === null
            || !$this->context->is_managed_path($path)
            || !$this->context->can($path, Acl::LIST)
        ) {
            return [
                'header' => ['content' => null, 'type' => null],
                'footer' => ['content' => null, 'type' => null]
            ];
        }

        $root_path = $this->context->get_setup()->get('ROOT_PATH');
        $stop_at_root = $this->context->query_option('custom.stopSearchingAtRoot', true) !== false;

        $this->read_custom_file($path, 'header', $header, $header_type);
        $this->read_custom_file($path, 'footer', $footer, $footer_type);

        while ($header === null || $footer === null) {
            if ($header === null) {
                $this->read_custom_file($path, 'headers', $header, $header_type);
            }
            if ($footer === null) {
                $this->read_custom_file($path, 'footers', $footer, $footer_type);
            }
            if ($stop_at_root && $path === $root_path) {
                break;
            }
            $parent_path = Util::normalize_path(dirname($path));
            if ($parent_path === $path) {
                break;
            }
            $path = $parent_path;
        }

        return [
            'header' => ['content' => $header, 'type' => $header_type],
            'footer' => ['content' => $footer, 'type' => $footer_type]
        ];
    }
}

<?php
declare(strict_types=1);

// Plain HTML listing for text browsers and the no-JavaScript case. Everything derived from
// file names is escaped: file names are attacker controlled in shared folders.
final class Fallback {
    public function __construct(private readonly Context $context) {}

    // 7.5 GB, 64 MB, 2 KB: same decimal units as the JS listing
    public static function format_size(int $bytes): string {
        $units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        $i = 0;
        $size = (float) $bytes;
        while ($size >= 1000 && $i < count($units) - 1) {
            $size /= 1000;
            $i += 1;
        }
        return ($i <= 1 ? (string) round($size) : number_format($size, 1)) . ' ' . $units[$i];
    }

    public function get_html(?string $path = null): string {
        $path = $path ?? $this->context->get_current_path();
        $images_href = $this->context->get_setup()->get('PUBLIC_HREF') . 'images/fallback/';

        $cache = [];
        $folder = Item::get($this->context, $path, $cache);
        if ($folder === null) {
            return '';
        }
        $items = $folder->get_content($cache);
        uasort($items, ['Item', 'cmp']);

        $html = '<table>';
        $html .= '<tr>';
        $html .= '<th class="fb-i"></th>';
        $html .= '<th class="fb-n"><span>Name</span></th>';
        $html .= '<th class="fb-d"><span>Last modified</span></th>';
        $html .= '<th class="fb-s"><span>Size</span></th>';
        $html .= '</tr>';

        if ($folder->get_parent($cache)) {
            $html .= '<tr>';
            $html .= '<td class="fb-i"><img src="' . Util::html($images_href) . 'folder-parent.png" alt="folder-parent"></td>';
            $html .= '<td class="fb-n"><a href="..">Parent folder</a></td>';
            $html .= '<td class="fb-d"></td>';
            $html .= '<td class="fb-s"></td>';
            $html .= '</tr>';
        }

        foreach ($items as $item) {
            $type = $item->is_folder ? 'folder' : 'file';

            $html .= '<tr>';
            $html .= '<td class="fb-i"><img src="' . Util::html($images_href . $type) . '.png" alt="' . $type . '"></td>';
            $html .= '<td class="fb-n"><a href="' . Util::html($item->href) . '">' . Util::html(basename($item->path)) . '</a></td>';
            $html .= '<td class="fb-d">' . ($item->date ? date('Y-m-d H:i', $item->date) : '') . '</td>';
            $html .= '<td class="fb-s">' . ($item->size !== null && !$item->is_folder ? Fallback::format_size($item->size) : '') . '</td>';
            $html .= '</tr>';
        }

        $html .= '</table>';

        return $html;
    }
}

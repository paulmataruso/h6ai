<?php
declare(strict_types=1);

final class Item {
    public static function cmp(Item $item1, Item $item2): int {
        if ($item1->is_folder && !$item2->is_folder) {
            return -1;
        }
        if (!$item1->is_folder && $item2->is_folder) {
            return 1;
        }

        return strcasecmp($item1->path, $item2->path);
    }

    public static function get(Context $context, ?string $path, array &$cache): ?Item {
        if ($path === null) {
            return null;
        }
        $root_path = $context->get_setup()->get('ROOT_PATH');
        if ($path !== $root_path && !Util::starts_with($path, $root_path . '/')) {
            return null;
        }

        if (array_key_exists($path, $cache)) {
            return $cache[$path];
        }

        $item = new Item($context, $path);
        $cache[$path] = $item;
        return $item;
    }

    public string $path;
    public string $href;
    public int $date;
    public ?int $size;
    public bool $is_folder;
    public bool $is_content_fetched = false;

    private function __construct(public readonly Context $context, string $path) {
        $this->path = Util::normalize_path($path, false);
        $this->is_folder = is_dir($this->path);
        $this->href = $context->to_href($this->path, $this->is_folder);
        $mtime = @filemtime($this->path);
        $this->date = $mtime === false ? 0 : $mtime;
        $this->size = Util::filesize($context, $this->path);
    }

    public function to_json_object(): array {
        $obj = [
            'href' => $this->href,
            'time' => $this->date * 1000, // seconds (PHP) to milliseconds (JavaScript)
            'size' => $this->size
        ];

        if ($this->is_folder) {
            $obj['managed'] = $this->context->is_managed_path($this->path);
            $obj['fetched'] = $this->is_content_fetched;
        }

        return $obj;
    }

    public function get_parent(array &$cache): ?Item {
        $parent_path = Util::normalize_path(dirname($this->path), false);
        if ($parent_path !== $this->path) {
            return Item::get($this->context, $parent_path, $cache);
        }
        return null;
    }

    public function get_content(array &$cache): array {
        $items = [];

        if (!$this->context->is_managed_path($this->path)) {
            return $items;
        }

        foreach ($this->context->read_dir($this->path) as $name) {
            $item = Item::get($this->context, $this->path . '/' . $name, $cache);
            if ($item !== null) {
                $items[$item->path] = $item;
            }
        }

        $this->is_content_fetched = true;

        return $items;
    }
}

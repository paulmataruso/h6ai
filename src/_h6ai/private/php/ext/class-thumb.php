<?php
declare(strict_types=1);

final class Thumb {
    private const THUMB_CACHE = 'thumbs';
    private const MAX_DIMENSION = 2048;
    private const DEFAULT_MAX_PIXELS = 40000000; // 40 MP
    private const CMD_TIMEOUT = 30;
    // Explicit ImageMagick/GraphicsMagick coders. Forcing the coder stops ImageMagick from
    // sniffing the file content and running a different (possibly dangerous) coder.
    private const DOC_CODERS = ['x-pdf' => 'pdf', 'x-ps' => 'ps'];

    private const DEFAULT_CACHE_MAX_MB = 1024;
    private const PRUNE_PROBABILITY = 50; // prune on average every 50th new thumbnail

    private Setup $setup;
    private string $secret;
    private string $thumbs_path;
    private string $thumbs_href;

    public function __construct(private readonly Context $context) {
        $this->setup = $context->get_setup();
        $this->secret = $context->get_secret();
        $this->thumbs_path = $this->setup->get('CACHE_PUB_PATH') . '/' . Thumb::THUMB_CACHE;
        $this->thumbs_href = $this->setup->get('CACHE_PUB_HREF') . Thumb::THUMB_CACHE;

        if (!is_dir($this->thumbs_path)) {
            @mkdir($this->thumbs_path, 0755, true);
        }
    }

    public function thumb(mixed $type, mixed $source_href, mixed $width, mixed $height): ?string {
        if (!is_string($type) || !in_array($type, ['img', 'mov', 'doc'], true)) {
            return null;
        }

        $width = Util::to_int($width, 1, Thumb::MAX_DIMENSION);
        $height = Util::to_int($height, 0, Thumb::MAX_DIMENSION);
        if ($width === null || $height === null) {
            return null;
        }

        $source_path = $this->context->to_path($source_href);
        if ($source_path === null || !$this->context->is_exposed_file($source_path)) {
            return null;
        }

        $file_type = $this->context->get_type(basename($source_path));
        if (!$this->is_allowed_type($type, $file_type)) {
            return null;
        }

        $capture_path = match ($type) {
            'img' => $source_path,
            'mov' => $this->capture_video($source_path),
            'doc' => $this->capture_doc($source_path, $file_type)
        };

        return $capture_path === null ? null : $this->thumb_href($capture_path, $width, $height);
    }

    private function is_allowed_type(string $type, string $file_type): bool {
        $allowed = (array) $this->context->query_option('thumbnails.' . $type, []);
        if ($type === 'img') {
            // image previews request samples through the thumbnail API as well
            $allowed = array_merge($allowed, (array) $this->context->query_option('preview-img.types', []));
        }
        return in_array($file_type, $allowed, true);
    }

    private function thumb_href(string $source_path, int $width, int $height): ?string {
        // keyed hash: thumbnail names of protected files can't be derived from their paths
        $name = 'thumb-' . $this->key($source_path . '|' . $width . 'x' . $height) . '.jpg';
        $thumb_path = $this->thumbs_path . '/' . $name;

        if (!is_file($thumb_path) || @filemtime($source_path) >= @filemtime($thumb_path)) {
            $image = new Image((int) $this->context->query_option('thumbnails.maxPixels', Thumb::DEFAULT_MAX_PIXELS));

            $exif_thumb = false;
            if ($this->setup->get('HAS_PHP_EXIF') && $this->context->query_option('thumbnails.exif', false) === true && $height !== 0) {
                $exif_thumb = @exif_thumbnail($source_path);
            }

            if (is_string($exif_thumb) && $exif_thumb !== '') {
                $image->set_source_data($exif_thumb);
            } else {
                $image->set_source($source_path);
            }
            if ($this->setup->get('HAS_PHP_EXIF')) {
                $image->normalize_exif_orientation($source_path);
            }

            $image->thumb($width, $height);
            if (!$image->save_dest_jpeg($thumb_path, 80)) {
                return null;
            }
            if (random_int(1, Thumb::PRUNE_PROBABILITY) === 1) {
                $this->prune();
            }
        }

        clearstatcache(true, $thumb_path);
        $mtime = @filemtime($thumb_path);
        // the version parameter lets clients cache thumbnails forever (immutable)
        if ($mtime === false) {
            return null;
        }
        // drop-in installs: through h6ai, which sends the cache headers (FileServer::asset)
        if ($this->setup->get('IS_DROPIN')) {
            return $this->setup->get('PUBLIC_HREF') . 'v/' . $mtime . '/cache/' . Thumb::THUMB_CACHE . '/' . $name;
        }
        return $this->thumbs_href . '/' . $name . '?v=' . $mtime;
    }

    private function key(string $value): string {
        return substr(hash_hmac('sha256', $value, $this->secret), 0, 40);
    }

    private function capture_path(string $source_path): string {
        return $this->thumbs_path . '/capture-' . $this->key($source_path) . '.jpg';
    }

    // Keeps the thumbnail cache below thumbnails.cacheMaxSize (MB) by deleting the least
    // recently modified files until it's down to 80%.
    private function prune(): void {
        $max = (int) $this->context->query_option('thumbnails.cacheMaxSize', Thumb::DEFAULT_CACHE_MAX_MB) * 1048576;
        if ($max <= 0) {
            return;
        }
        $files = [];
        $total = 0;
        foreach (glob($this->thumbs_path . '/*.jpg') ?: [] as $file) {
            $stat = @stat($file);
            if ($stat !== false) {
                $files[] = [$file, $stat['mtime'], $stat['size']];
                $total += $stat['size'];
            }
        }
        if ($total <= $max) {
            return;
        }
        usort($files, fn ($a, $b) => $a[1] <=> $b[1]);
        foreach ($files as [$file, , $size]) {
            if ($total <= $max * 0.8) {
                break;
            }
            if (@unlink($file)) {
                $total -= $size;
            }
        }
    }

    private function is_fresh(string $capture_path, string $source_path): bool {
        return is_file($capture_path) && @filemtime($source_path) < @filemtime($capture_path);
    }

    private function run(array $argv): void {
        Util::exec_argv(Util::with_timeout($this->setup, $argv, Thumb::CMD_TIMEOUT));
    }

    private function capture_video(string $source_path): ?string {
        $capture_path = $this->capture_path($source_path);
        if ($this->is_fresh($capture_path, $source_path)) {
            return $capture_path;
        }

        $cmd = $this->setup->get('HAS_CMD_FFMPEG') ? 'ffmpeg' : ($this->setup->get('HAS_CMD_AVCONV') ? 'avconv' : null);
        if ($cmd === null) {
            return null;
        }

        @unlink($capture_path);
        // seek 10s in for a representative frame; clips shorter than that fall back to 0s
        foreach (['10', '0'] as $seek) {
            $this->run([
                $cmd, '-nostdin', '-loglevel', 'error', '-y',
                '-ss', $seek, '-i', 'file:' . $source_path,
                '-an', '-frames:v', '1', '-f', 'image2', 'file:' . $capture_path
            ]);
            clearstatcache(true, $capture_path);
            if (is_file($capture_path) && filesize($capture_path) > 0) {
                return $capture_path;
            }
        }
        return null;
    }

    private function capture_doc(string $source_path, string $file_type): ?string {
        $coder = Thumb::DOC_CODERS[$file_type] ?? null;
        if ($coder === null) {
            return null;
        }

        $capture_path = $this->capture_path($source_path);
        if ($this->is_fresh($capture_path, $source_path)) {
            return $capture_path;
        }

        $source = $coder . ':' . $source_path . '[0]';
        $dest = 'jpg:' . $capture_path;
        $args = ['-density', '150', $source, '-background', 'white', '-alpha', 'remove', '-quality', '90', $dest];

        if ($this->setup->get('HAS_CMD_GS')) {
            // Ghostscript directly: ImageMagick would call it anyway, and Debian and Ubuntu disable
            // PDF in their system-wide ImageMagick policy. First page only, no file access (SAFER).
            $argv = ['gs', '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dFirstPage=1', '-dLastPage=1',
                '-sDEVICE=jpeg', '-dJPEGQ=90', '-r150', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                '-sOutputFile=' . str_replace('%', '%%', $capture_path), '-f', $source_path];
        } elseif ($this->setup->get('HAS_CMD_MAGICK')) {
            $argv = array_merge(['magick'], $args);
        } elseif ($this->setup->get('HAS_CMD_CONVERT')) {
            $argv = array_merge(['convert'], $args);
        } elseif ($this->setup->get('HAS_CMD_GM')) {
            $argv = ['gm', 'convert', '-density', '150', $source, '-quality', '90', $dest];
        } else {
            return null;
        }

        @unlink($capture_path);
        $this->run($argv);
        clearstatcache(true, $capture_path);
        return is_file($capture_path) && filesize($capture_path) > 0 ? $capture_path : null;
    }
}

final class Image {
    private ?GdImage $source = null;
    private int $width = 0;
    private int $height = 0;
    private ?GdImage $dest = null;

    public function __construct(private readonly int $max_pixels) {}

    private static function to_bytes(string $value): int {
        $value = trim($value);
        $num = (int) $value;
        return match (strtolower(substr($value, -1))) {
            'g' => $num * 1073741824,
            'm' => $num * 1048576,
            'k' => $num * 1024,
            default => $num
        };
    }

    // GD needs ~5 bytes per pixel for truecolor images (source + thumbnail). Refuse sources above
    // the pixel cap (decompression bombs) and sources that wouldn't fit into the remaining memory.
    // The memory limit is never raised: running into it is exactly what CVE-2026-109618 exploits,
    // so attacker controlled input must not be able to drive PHP into an out-of-memory state.
    private function ensure_memory(int $width, int $height): bool {
        if ($width <= 0 || $height <= 0 || $width * $height > $this->max_pixels) {
            return false;
        }
        $limit = ini_get('memory_limit');
        if ($limit === false || $limit === '-1') {
            return true;
        }
        $needed = $width * $height * 5 + 16 * 1048576; // pixels + headroom for the thumbnail
        return memory_get_usage() + $needed < Image::to_bytes($limit) * 0.8;
    }

    public function set_source(string $filename): void {
        $this->release();
        $info = @getimagesize($filename);
        if ($info === false || !$this->ensure_memory($info[0], $info[1])) {
            return;
        }
        $data = @file_get_contents($filename);
        $this->load($data === false ? '' : $data);
    }

    public function set_source_data(string $data): void {
        $this->release();
        $info = @getimagesizefromstring($data);
        if ($info === false || !$this->ensure_memory($info[0], $info[1])) {
            return;
        }
        $this->load($data);
    }

    private function load(string $data): void {
        if ($data === '') {
            return;
        }
        $image = @imagecreatefromstring($data);
        if ($image instanceof GdImage) {
            $this->source = $image;
            $this->width = imagesx($image);
            $this->height = imagesy($image);
        }
    }

    public function save_dest_jpeg(string $filename, int $quality = 80): bool {
        if ($this->dest === null) {
            return false;
        }
        $tmp = $filename . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if (!@imagejpeg($this->dest, $tmp, $quality)) {
            @unlink($tmp);
            return false;
        }
        @chmod($tmp, 0644);
        return @rename($tmp, $filename);
    }

    private function release(): void {
        $this->source = null;
        $this->dest = null;
        $this->width = 0;
        $this->height = 0;
    }

    public function thumb(int $width, int $height): void {
        if ($this->source === null) {
            return;
        }

        $src_r = 1.0 * $this->width / $this->height;

        if ($height === 0) {
            if ($src_r >= 1) {
                $height = $width / $src_r;
            } else {
                $height = $width;
                $width = $height * $src_r;
            }
            if ($width > $this->width) {
                $width = $this->width;
                $height = $this->height;
            }
        }

        $ratio = 1.0 * $width / $height;

        if ($src_r <= $ratio) {
            $src_w = $this->width;
            $src_h = $src_w / $ratio;
            $src_x = 0;
        } else {
            $src_h = $this->height;
            $src_w = $src_h * $ratio;
            $src_x = 0.5 * ($this->width - $src_w);
        }

        $width = max(1, (int) round($width));
        $height = max(1, (int) round($height));

        $this->dest = imagecreatetruecolor($width, $height);
        imagefill($this->dest, 0, 0, imagecolorallocate($this->dest, 255, 255, 255));
        imagecopyresampled($this->dest, $this->source, 0, 0, (int) $src_x, 0, $width, $height, (int) $src_w, (int) $src_h);
    }

    private function rotate(int $angle): void {
        if ($this->source === null || !in_array($angle, [90, 180, 270], true)) {
            return;
        }

        $rotated = imagerotate($this->source, $angle, 0);
        if ($rotated instanceof GdImage) {
            $this->source = $rotated;
            if ($angle === 90 || $angle === 270) {
                [$this->width, $this->height] = [$this->height, $this->width];
            }
        }
    }

    public function normalize_exif_orientation(string $exif_source_file): void {
        if ($this->source === null || !function_exists('exif_read_data')) {
            return;
        }

        $exif = @exif_read_data($exif_source_file);
        match (is_array($exif) ? ($exif['Orientation'] ?? 1) : 1) {
            3 => $this->rotate(180),
            6 => $this->rotate(270),
            8 => $this->rotate(90),
            default => null
        };
    }
}

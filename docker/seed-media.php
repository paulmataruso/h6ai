<?php
// Generates deterministic sample media for the h6ai test tree.
// Usage: php seed-media.php <command> <args...>
//   images <dir>          photo.jpg photo.png photo.webp photo.gif photo.avif rotated-exif6.jpg wide.jpg
//   bomb <file>           PNG whose header claims 30000x30000 pixels (decompression bomb)
//   jpeg <file> <w> <h>   plain JPEG
//   pdf <file>            minimal one-page PDF
//   bigfile <file> <MiB>  deterministic binary file: every 8-byte block holds its own byte
//                         offset as big-endian uint64 (lets tests verify Range responses exactly)

declare(strict_types=1);

function canvas(int $w, int $h, int $seed) {
    $im = imagecreatetruecolor($w, $h);
    mt_srand($seed);
    $c1 = [mt_rand(0, 255), mt_rand(0, 255), mt_rand(0, 255)];
    $c2 = [mt_rand(0, 255), mt_rand(0, 255), mt_rand(0, 255)];
    for ($y = 0; $y < $h; $y++) {
        $t = $y / max(1, $h - 1);
        $col = imagecolorallocate($im,
            (int) ($c1[0] + ($c2[0] - $c1[0]) * $t),
            (int) ($c1[1] + ($c2[1] - $c1[1]) * $t),
            (int) ($c1[2] + ($c2[2] - $c1[2]) * $t));
        imageline($im, 0, $y, $w - 1, $y, $col);
    }
    for ($i = 0; $i < 12; $i++) {
        $col = imagecolorallocatealpha($im, mt_rand(0, 255), mt_rand(0, 255), mt_rand(0, 255), 40);
        imagefilledellipse($im, mt_rand(0, $w), mt_rand(0, $h), mt_rand(intdiv($w, 10), intdiv($w, 3)), mt_rand(intdiv($h, 10), intdiv($h, 3)), $col);
    }
    // an arrow pointing "up" so wrong EXIF rotation is obvious
    $white = imagecolorallocate($im, 255, 255, 255);
    $cx = intdiv($w, 2);
    imagefilledpolygon($im, [$cx, intdiv($h, 8), $cx - intdiv($w, 10), intdiv($h, 3), $cx + intdiv($w, 10), intdiv($h, 3)], $white);
    imagefilledrectangle($im, $cx - intdiv($w, 40), intdiv($h, 3), $cx + intdiv($w, 40), intdiv($h * 7, 8), $white);
    imagestring($im, 5, 10, 10, "h6ai sample {$w}x{$h} #{$seed}", $white);
    return $im;
}

function jpeg_bytes($im, int $quality = 85): string {
    ob_start();
    imagejpeg($im, null, $quality);
    return (string) ob_get_clean();
}

// Insert an APP1/EXIF segment with only the Orientation tag right after SOI.
function with_exif_orientation(string $jpeg, int $orientation): string {
    $tiff = 'MM' . "\x00\x2A" . pack('N', 8)        // big-endian TIFF header, IFD0 at offset 8
        . pack('n', 1)                                // one entry
        . pack('nnN', 0x0112, 3, 1) . pack('nn', $orientation, 0) // Orientation, SHORT, 1
        . pack('N', 0);                               // no next IFD
    $payload = "Exif\x00\x00" . $tiff;
    $app1 = "\xFF\xE1" . pack('n', strlen($payload) + 2) . $payload;
    return substr($jpeg, 0, 2) . $app1 . substr($jpeg, 2);
}

function png_chunk(string $type, string $data): string {
    return pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
}

function cmd_images(string $dir): void {
    @mkdir($dir, 0755, true);
    $im = canvas(1600, 1000, 1);
    file_put_contents("$dir/photo.jpg", jpeg_bytes($im));
    imagepng(canvas(1200, 900, 2), "$dir/photo.png");
    if (function_exists('imagewebp')) {
        imagewebp(canvas(1400, 900, 3), "$dir/photo.webp", 80);
    }
    if (function_exists('imageavif')) {
        imageavif(canvas(800, 600, 4), "$dir/photo.avif", 60, 10);
    }
    $gif = canvas(640, 480, 5);
    imagetruecolortopalette($gif, true, 128);
    imagegif($gif, "$dir/photo.gif");
    // Landscape pixels, EXIF says "rotate 90 CW" (orientation 6) -> should display as portrait.
    file_put_contents("$dir/rotated-exif6.jpg", with_exif_orientation(jpeg_bytes(canvas(1200, 800, 6)), 6));
    file_put_contents("$dir/wide.jpg", jpeg_bytes(canvas(3000, 600, 7)));
    file_put_contents("$dir/tiny.jpg", jpeg_bytes(canvas(32, 24, 8)));
}

function cmd_bomb(string $file): void {
    $ihdr = pack('NN', 30000, 30000) . "\x08\x02\x00\x00\x00"; // 8-bit RGB
    $png = "\x89PNG\r\n\x1a\n"
        . png_chunk('IHDR', $ihdr)
        . png_chunk('IDAT', gzcompress(str_repeat("\x00", 64)))
        . png_chunk('IEND', '');
    file_put_contents($file, $png);
}

function cmd_jpeg(string $file, int $w, int $h): void {
    file_put_contents($file, jpeg_bytes(canvas($w, $h, crc32($file) & 0xffff)));
}

function cmd_pdf(string $file): void {
    $content = "BT /F1 36 Tf 72 720 Td (h6ai sample PDF) Tj ET\n"
        . "BT /F1 18 Tf 72 680 Td (Page 1 - used for document thumbnails) Tj ET\n"
        . "0.2 0.4 0.8 rg 72 200 451 400 re f\n";
    $objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        "<< /Length " . strlen($content) . " >>\nstream\n" . $content . "endstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    $pdf = "%PDF-1.4\n";
    $offsets = [];
    foreach ($objects as $i => $obj) {
        $offsets[] = strlen($pdf);
        $pdf .= ($i + 1) . " 0 obj\n" . $obj . "\nendobj\n";
    }
    $xref = strlen($pdf);
    $pdf .= "xref\n0 " . (count($objects) + 1) . "\n0000000000 65535 f \n";
    foreach ($offsets as $off) {
        $pdf .= sprintf("%010d 00000 n \n", $off);
    }
    $pdf .= "trailer\n<< /Size " . (count($objects) + 1) . " /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n";
    file_put_contents($file, $pdf);
}

function cmd_bigfile(string $file, int $mib): void {
    $fh = fopen($file, 'wb');
    $perChunk = 131072; // 1 MiB / 8
    for ($c = 0; $c < $mib; $c++) {
        $base = $c * $perChunk * 8;
        fwrite($fh, pack('J*', ...range($base, $base + ($perChunk - 1) * 8, 8)));
    }
    fclose($fh);
}

$cmd = $argv[1] ?? '';
switch ($cmd) {
    case 'images': cmd_images($argv[2]); break;
    case 'bomb': cmd_bomb($argv[2]); break;
    case 'jpeg': cmd_jpeg($argv[2], (int) $argv[3], (int) $argv[4]); break;
    case 'pdf': cmd_pdf($argv[2]); break;
    case 'bigfile': cmd_bigfile($argv[2], (int) $argv[3]); break;
    default:
        fwrite(STDERR, "usage: php seed-media.php images|bomb|jpeg|pdf|bigfile ...\n");
        exit(2);
}

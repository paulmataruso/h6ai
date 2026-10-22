<?php
declare(strict_types=1);

final class Logger {
    public static function log(string $message, mixed $obj = null): void {
        @error_log('[h6ai] ' . $message . ($obj === null ? '' : ' ' . json_encode($obj, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR)));
    }
}

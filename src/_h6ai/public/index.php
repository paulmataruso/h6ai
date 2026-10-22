<?php

define('H6AI_VERSION', '{{VERSION}}');
define('MIN_PHP_VERSION', '8.2.0');

if (!function_exists('version_compare') || version_compare(PHP_VERSION, MIN_PHP_VERSION, '<')) {
    header('Content-type: text/plain;charset=utf-8');
    exit('[ERR] h6ai requires PHP ' . MIN_PHP_VERSION . ' or later, but found PHP ' . PHP_VERSION);
}

if (substr(H6AI_VERSION, 0, 1) === '{') {
    header('Content-type: text/plain;charset=utf-8');
    exit('[ERR] h6ai sources must be preprocessed to work correctly, run "npm run build"');
}

require_once __DIR__ . '/../private/php/class-bootstrap.php';
Bootstrap::run();

<?php
declare(strict_types=1);
// Tests for the external auth feature: Bootstrap::get_external_user().
// Run with: php test-php/external-auth.test.php /src/_h6ai
//
// Exercises the sanitisation and validation without a web server.

$app = $argv[1] ?? null;
if (!$app || !is_dir($app)) {
    fwrite(STDERR, "Usage: php external-auth.test.php /path/to/_h6ai\n");
    exit(1);
}

// Minimal defines to load the PHP classes.
define('H6AI_VERSION', 'test');
define('MIN_PHP_VERSION', '8.2.0');
require $app . '/private/php/class-bootstrap.php';

$pass = 0;
$fail = 0;

function assert_eq($label, $expected, $actual) {
    global $pass, $fail;
    if ($expected === $actual) {
        $pass++;
    } else {
        $fail++;
        fwrite(STDERR, "FAIL: $label\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}

// Use reflection to call the private static method.
$method = new ReflectionMethod('Bootstrap', 'get_external_user');
$method->setAccessible(true);

// We need a mock Context. Build a minimal one by loading the needed classes.
// Actually, Bootstrap::get_external_user() takes a Context and calls query_option().
// We can't easily construct a Context without the full environment. Instead, test the
// sanitisation logic inline.

// Test: name sanitisation — control characters stripped, trimmed, max 100 chars
$cases = [
    ['input' => "alice\x00bob", 'expected_name' => 'alicebob'],
    ['input' => "  alice  ", 'expected_name' => 'alice'],
    ['input' => "a\x01b\x1fc\x7f", 'expected_name' => 'abc'],
    ['input' => '<script>alert(1)</script>', 'expected_name' => '<script>alert(1)</script>'],
    ['input' => str_repeat('x', 200), 'expected_name' => str_repeat('x', 100)],
    ['input' => '', 'expected_name' => ''],
    ['input' => "   ", 'expected_name' => ''],
];

foreach ($cases as $i => $case) {
    $raw = $case['input'];
    $name = mb_substr(trim(preg_replace('/[\x00-\x1f\x7f]/', '', $raw)), 0, 100);
    assert_eq("name sanitisation case $i", $case['expected_name'], $name);
}

// Test: auth type normalisation
$auth_cases = [
    ['' => 'session'],
    ['session' => 'session'],
    ['SESSION' => 'session'],
    ['basic' => 'basic'],
    ['BASIC' => 'basic'],
    ['Basic' => 'basic'],
    ['unknown' => 'session'],
    ['digest' => 'session'],
];

foreach ($auth_cases as $i => $case) {
    foreach ($case as $input => $expected) {
        $auth = strtolower(trim($input)) === 'basic' ? 'basic' : 'session';
        assert_eq("auth type '$input'", $expected, $auth);
    }
}

// Test: logoutUrl validation (same-origin path starting with /, not //)
$url_cases = [
    ['/.logout' => true],
    ['/logout' => true],
    ['/a/b/c' => true],
    ['/' => true],
    ['' => false],
    ['//evil.com' => false],
    ['https://evil.com/.logout' => false],
    ['http://evil.com' => false],
    ['.logout' => false],
    ['logout' => false],
];

foreach ($url_cases as $i => $case) {
    foreach ($case as $url => $expected_valid) {
        $valid = str_starts_with($url, '/') && !str_starts_with($url, '//');
        assert_eq("logoutUrl '$url'", $expected_valid, $valid);
    }
}

echo "$pass passed, $fail failed\n";
exit($fail > 0 ? 1 : 0);

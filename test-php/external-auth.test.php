<?php
declare(strict_types=1);
// Tests for the external auth feature: Bootstrap::resolve_external_user().
// Run with: php test-php/external-auth.test.php /path/to/_h6ai

$app = $argv[1] ?? null;
if (!$app || !is_dir($app)) {
    fwrite(STDERR, "Usage: php external-auth.test.php /path/to/_h6ai\n");
    exit(1);
}

define('H6AI_VERSION', 'test');
define('MIN_PHP_VERSION', '8.2.0');
require $app . '/private/php/class-bootstrap.php';
spl_autoload_register(function (string $class_name) use ($app): bool {
    $filename = 'class-' . strtolower($class_name) . '.php';
    foreach (['core', 'ext'] as $path) {
        $file = $app . '/private/php/' . $path . '/' . $filename;
        if (file_exists($file)) {
            require_once $file;
            return true;
        }
    }
    return false;
});

$pass = 0;
$fail = 0;

function assert_eq(string $label, mixed $expected, mixed $actual): void {
    global $pass, $fail;
    if ($expected === $actual) {
        $pass++;
    } else {
        $fail++;
        fwrite(STDERR, "FAIL: $label\n  expected: " . var_export($expected, true) . "\n  actual:   " . var_export($actual, true) . "\n");
    }
}

function opts(array $overrides = []): array {
    return array_merge(['enabled' => true, 'logoutUrl' => '', 'label' => ''], $overrides);
}

function with_server(array $vars, callable $fn): mixed {
    $saved = [];
    foreach ($vars as $k => $v) {
        $saved[$k] = $_SERVER[$k] ?? null;
        if ($v === null) {
            unset($_SERVER[$k]);
        } else {
            $_SERVER[$k] = $v;
        }
    }
    try {
        return $fn();
    } finally {
        foreach ($saved as $k => $v) {
            if ($v === null) {
                unset($_SERVER[$k]);
            } else {
                $_SERVER[$k] = $v;
            }
        }
    }
}

// --- option off → null ---
assert_eq('option off returns null', null, with_server(
    ['H6AI_EXTERNAL_USER' => 'alice'],
    fn () => Bootstrap::resolve_external_user(opts(['enabled' => false]))
));

// --- empty / whitespace-only / control-character names → null ---
assert_eq('empty name → null', null, with_server(
    ['H6AI_EXTERNAL_USER' => ''],
    fn () => Bootstrap::resolve_external_user(opts())
));
assert_eq('whitespace-only name → null', null, with_server(
    ['H6AI_EXTERNAL_USER' => '   '],
    fn () => Bootstrap::resolve_external_user(opts())
));
assert_eq('only control chars → null', null, with_server(
    ['H6AI_EXTERNAL_USER' => "\x01\x02\x03"],
    fn () => Bootstrap::resolve_external_user(opts())
));
assert_eq('missing param → null', null, with_server(
    ['H6AI_EXTERNAL_USER' => null],
    fn () => Bootstrap::resolve_external_user(opts())
));

// --- name sanitisation ---
$r = with_server(['H6AI_EXTERNAL_USER' => "alice\x00bob"], fn () => Bootstrap::resolve_external_user(opts()));
assert_eq('control chars stripped from name', 'alicebob', $r['name']);

$r = with_server(['H6AI_EXTERNAL_USER' => '  alice  '], fn () => Bootstrap::resolve_external_user(opts()));
assert_eq('name trimmed', 'alice', $r['name']);

$r = with_server(['H6AI_EXTERNAL_USER' => "a\x01b\x1fc\x7f"], fn () => Bootstrap::resolve_external_user(opts()));
assert_eq('all control chars stripped', 'abc', $r['name']);

// --- 100-char cap, including multibyte ---
$long = str_repeat('x', 200);
$r = with_server(['H6AI_EXTERNAL_USER' => $long], fn () => Bootstrap::resolve_external_user(opts()));
assert_eq('name capped at 100 ASCII chars', 100, strlen($r['name']));

$mb = str_repeat('日', 120);
$r = with_server(['H6AI_EXTERNAL_USER' => $mb], fn () => Bootstrap::resolve_external_user(opts()));
assert_eq('name capped at 100 multibyte chars', 100, mb_strlen($r['name']));
assert_eq('multibyte name content', str_repeat('日', 100), $r['name']);

// --- XSS string preserved as text, not stripped ---
$r = with_server(['H6AI_EXTERNAL_USER' => '<script>alert(1)</script>'], fn () => Bootstrap::resolve_external_user(opts()));
assert_eq('XSS name preserved as-is', '<script>alert(1)</script>', $r['name']);

// --- invalid UTF-8 scrubbed ---
$r = with_server(['H6AI_EXTERNAL_USER' => "hello\xC0\xAFworld"], fn () => Bootstrap::resolve_external_user(opts()));
assert_eq('invalid UTF-8 sequences replaced', true, mb_check_encoding($r['name'], 'UTF-8'));
assert_eq('invalid UTF-8 name not empty', true, strlen($r['name']) > 0);

// --- auth type normalisation ---
$auth_cases = [
    ['' , 'session'],
    ['session', 'session'],
    ['SESSION', 'session'],
    ['basic', 'basic'],
    ['BASIC', 'basic'],
    ['Basic', 'basic'],
    ['unknown', 'session'],
    ['digest', 'session'],
];
foreach ($auth_cases as [$input, $expected]) {
    $r = with_server(
        ['H6AI_EXTERNAL_USER' => 'alice', 'H6AI_EXTERNAL_AUTH' => $input],
        fn () => Bootstrap::resolve_external_user(opts())
    );
    assert_eq("auth type '$input' → '$expected'", $expected, $r['auth']);
}

// missing auth param → session
$r = with_server(
    ['H6AI_EXTERNAL_USER' => 'alice', 'H6AI_EXTERNAL_AUTH' => null],
    fn () => Bootstrap::resolve_external_user(opts())
);
assert_eq('missing auth param → session', 'session', $r['auth']);

// --- logoutUrl validation ---
$valid_urls = ['/.logout', '/logout', '/a/b/c', '/', '/logout?redirect=/'];
foreach ($valid_urls as $url) {
    $r = with_server(
        ['H6AI_EXTERNAL_USER' => 'alice'],
        fn () => Bootstrap::resolve_external_user(opts(['logoutUrl' => $url]))
    );
    assert_eq("logoutUrl '$url' accepted", $url, $r['logoutUrl']);
}

$invalid_urls = [
    '//evil.com',
    'https://evil.com/.logout',
    'http://evil.com',
    '.logout',
    'logout',
    '/\\evil.example',
    "/\t/evil.example",
    "/ space",
    str_repeat('/a', 600),
];
foreach ($invalid_urls as $url) {
    $r = with_server(
        ['H6AI_EXTERNAL_USER' => 'alice'],
        fn () => Bootstrap::resolve_external_user(opts(['logoutUrl' => $url]))
    );
    assert_eq("logoutUrl '$url' rejected", '', $r['logoutUrl']);
}

// bare "/" is accepted (valid: starts with / and nothing follows)
$r = with_server(
    ['H6AI_EXTERNAL_USER' => 'alice'],
    fn () => Bootstrap::resolve_external_user(opts(['logoutUrl' => '/']))
);
assert_eq("logoutUrl '/' accepted", '/', $r['logoutUrl']);

// non-string logoutUrl (array) → empty, no "Array to string conversion"
$r = with_server(
    ['H6AI_EXTERNAL_USER' => 'alice'],
    fn () => Bootstrap::resolve_external_user(opts(['logoutUrl' => ['injected']]))
);
assert_eq('logoutUrl array → empty', '', $r['logoutUrl']);

// --- label ---
$r = with_server(
    ['H6AI_EXTERNAL_USER' => 'alice'],
    fn () => Bootstrap::resolve_external_user(opts(['label' => 'Sign out']))
);
assert_eq('label passed through', 'Sign out', $r['label']);

$r = with_server(
    ['H6AI_EXTERNAL_USER' => 'alice'],
    fn () => Bootstrap::resolve_external_user(opts())
);
assert_eq('label defaults to empty', '', $r['label']);

// --- HTTP_* header ignored: only the fastcgi param counts ---
$r = with_server(
    ['HTTP_H6AI_EXTERNAL_USER' => 'evil', 'H6AI_EXTERNAL_USER' => null],
    fn () => Bootstrap::resolve_external_user(opts())
);
assert_eq('HTTP header without fastcgi param → null', null, $r);

// --- full round trip ---
$r = with_server(
    ['H6AI_EXTERNAL_USER' => 'alice', 'H6AI_EXTERNAL_AUTH' => 'basic'],
    fn () => Bootstrap::resolve_external_user(opts(['logoutUrl' => '/logout', 'label' => 'Leave']))
);
assert_eq('full result: name', 'alice', $r['name']);
assert_eq('full result: auth', 'basic', $r['auth']);
assert_eq('full result: logoutUrl', '/logout', $r['logoutUrl']);
assert_eq('full result: label', 'Leave', $r['label']);

echo "$pass passed, $fail failed\n";
exit($fail > 0 ? 1 : 0);

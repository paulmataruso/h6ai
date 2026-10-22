<?php
// Prints a password hash for the "passhash" option (or the H6AI_PASSHASH env variable).
//   php _h6ai/private/bin/h6ai-passhash.php            (prompts for the password)
//   echo -n 'secret' | php _h6ai/private/bin/h6ai-passhash.php -

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

if (($argv[1] ?? '') === '-') {
    $pass = stream_get_contents(STDIN);
} else {
    fwrite(STDERR, 'Password: ');
    $tty = stream_isatty(STDIN);
    if ($tty) {
        shell_exec('stty -echo');
    }
    $pass = rtrim((string) fgets(STDIN), "\r\n");
    if ($tty) {
        shell_exec('stty echo');
    }
    fwrite(STDERR, PHP_EOL);
}

if ($pass === false || $pass === '') {
    fwrite(STDERR, 'empty password, nothing to do' . PHP_EOL);
    exit(1);
}

echo password_hash($pass, PASSWORD_DEFAULT), PHP_EOL;

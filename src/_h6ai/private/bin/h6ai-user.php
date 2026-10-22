<?php
declare(strict_types=1);

// Manages h6ai users from the shell: the first admin, a lost password, a quick look at accounts.
//
//   php _h6ai/private/bin/h6ai-user.php list
//   php _h6ai/private/bin/h6ai-user.php add NAME [--admin | --anon] [--password-stdin | --generate]
//   php _h6ai/private/bin/h6ai-user.php passwd NAME [--password-stdin | --generate]
//   php _h6ai/private/bin/h6ai-user.php enable NAME | disable NAME
//   php _h6ai/private/bin/h6ai-user.php has-admin      exit status 0 if an enabled admin exists
//
// Without --password-stdin or --generate the password is prompted for. --generate prints a new
// random password. A password change signs the user out everywhere.
//
// Run it as the PHP-FPM user (the owner of private/data); the `h6ai-user` command of the Docker
// image and of the native install does that. Started as root it switches to that user itself.

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../php/class-bootstrap.php';
spl_autoload_register([Bootstrap::class, 'autoload']);

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

function fail(string $message, int $status = 1): never {
    fwrite(STDERR, 'h6ai-user: ' . $message . PHP_EOL);
    exit($status);
}

function usage(): never {
    fwrite(STDERR, <<<'TXT'
        usage: h6ai-user list
               h6ai-user add NAME [--admin | --anon] [--password-stdin | --generate]
               h6ai-user passwd NAME [--password-stdin | --generate]
               h6ai-user enable NAME | disable NAME
               h6ai-user has-admin

        TXT);
    exit(2);
}

// Files written as root would lock PHP-FPM out of its own data, so drop to the data owner.
function drop_privileges(string $data_path): void {
    if (!function_exists('posix_geteuid')) {
        return;
    }
    $owner = @fileowner($data_path);
    $group = @filegroup($data_path);
    if (posix_geteuid() !== 0 || $owner === false || $owner === 0) {
        return;
    }
    $user = posix_getpwuid($owner);
    if (!posix_setgid((int) $group) || ($user && !posix_initgroups($user['name'], (int) $group)) || !posix_setuid($owner)) {
        fail('cannot switch to the owner of ' . $data_path);
    }
}

function read_password(array $flags): array {
    if (in_array('--generate', $flags, true)) {
        $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $password = '';
        for ($i = 0; $i < 20; $i += 1) {
            $password .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        return [$password, true];
    }

    if (in_array('--password-stdin', $flags, true)) {
        $password = rtrim((string) fgets(STDIN), "\r\n");
    } else {
        if (!stream_isatty(STDIN)) {
            fail('no terminal to ask for the password: use --password-stdin or --generate');
        }
        $ask = function (string $prompt): string {
            fwrite(STDERR, $prompt);
            shell_exec('stty -echo');
            $line = rtrim((string) fgets(STDIN), "\r\n");
            shell_exec('stty echo');
            fwrite(STDERR, PHP_EOL);
            return $line;
        };
        $password = $ask('Password: ');
        if ($password !== $ask('Repeat password: ')) {
            fail('the passwords do not match');
        }
    }

    if (mb_strlen($password) < MIN_PASSWORD_LENGTH || strlen($password) > MAX_PASSWORD_LENGTH) {
        fail('the password needs at least ' . MIN_PASSWORD_LENGTH . ' characters');
    }
    return [$password, false];
}

function enabled_admins(array $data): int {
    $count = 0;
    foreach ($data['users'] as $user) {
        if (empty($user['disabled']) && ($user['type'] ?? 'standard') !== 'anon'
            && in_array('admin', (array) ($user['roles'] ?? []), true)) {
            $count += 1;
        }
    }
    return $count;
}

$args = array_slice($argv, 1);
$flags = array_values(array_filter($args, fn ($a) => str_starts_with($a, '--')));
$words = array_values(array_filter($args, fn ($a) => !str_starts_with($a, '--')));
$command = $words[0] ?? '';
$name = $words[1] ?? null;

$known = ['--admin', '--anon', '--password-stdin', '--generate'];
if ($command === '' || array_diff($flags, $known) || count($words) > 2) {
    usage();
}

$private_path = dirname(__DIR__);
$data_path = $private_path . '/data';
drop_privileges($data_path);
$store = new AuthStore($data_path, $private_path . '/cache');

if ($command === 'list') {
    $users = $store->load()['users'];
    if (!$users) {
        echo 'no users', PHP_EOL;
        exit(0);
    }
    printf('%-24s %-9s %-20s %-9s %s%s', 'NAME', 'TYPE', 'ROLES', 'STATUS', 'LAST LOGIN', PHP_EOL);
    foreach ($users as $user_name => $user) {
        printf('%-24s %-9s %-20s %-9s %s%s', $user_name, $user['type'] ?? 'standard',
            implode(',', (array) ($user['roles'] ?? [])) ?: '-', empty($user['disabled']) ? 'enabled' : 'disabled',
            empty($user['lastLogin']) ? 'never' : gmdate('Y-m-d H:i', (int) $user['lastLogin']) . ' UTC', PHP_EOL);
    }
    exit(0);
}

if ($command === 'has-admin') {
    exit(enabled_admins($store->load()) > 0 ? 0 : 1);
}

if (!in_array($command, ['add', 'passwd', 'enable', 'disable'], true) || $name === null) {
    usage();
}
if (preg_match(AuthStore::NAME_RE, $name) !== 1) {
    fail('invalid user name (letters, digits and . _ @ -, max 64 chars)');
}
if (!$store->is_writable()) {
    fail('the data folder ' . $data_path . ' is not writable for this user');
}

$exists = $store->get_user($name) !== null;
if ($command === 'add' && $exists) {
    fail('user "' . $name . '" already exists (use passwd to set a new password)');
}
if ($command !== 'add' && !$exists) {
    fail('no user "' . $name . '"');
}
if ($command === 'add' && in_array('--admin', $flags, true) && in_array('--anon', $flags, true)) {
    fail('an anon account can not be an admin');
}

[$password, $generated] = in_array($command, ['add', 'passwd'], true) ? read_password($flags) : [null, false];

try {
    $store->update(function ($data) use ($command, $name, $password, $flags) {
        $user = $data['users'][$name] ?? null;
        if ($command === 'add') {
            $anon = in_array('--anon', $flags, true);
            $user = [
                'created' => time(), 'lastLogin' => null, 'version' => 0,
                'type' => $anon ? 'anon' : 'standard',
                'roles' => $anon ? [] : (in_array('--admin', $flags, true) ? ['admin'] : ['user']),
                'access' => [], 'disabled' => false
            ];
        } else {
            $admins_before = enabled_admins($data);
            $user['version'] = (int) ($user['version'] ?? 0) + 1; // signs the user out everywhere
            if ($command === 'enable' || $command === 'disable') {
                $user['disabled'] = $command === 'disable';
            }
        }
        if ($password !== null) {
            $user['hash'] = password_hash($password, PASSWORD_DEFAULT);
        }
        $data['users'][$name] = $user;
        if ($command === 'disable' && $admins_before > 0 && enabled_admins($data) === 0) {
            throw new RuntimeException('at least one enabled admin is required');
        }
        return $data;
    });
} catch (Throwable $e) {
    fail($e->getMessage());
}

if ($generated) {
    echo $password, PHP_EOL;
} else {
    $done = ['add' => 'created', 'passwd' => 'password changed for', 'enable' => 'enabled', 'disable' => 'disabled'];
    fwrite(STDERR, $done[$command] . ' "' . $name . '"' . PHP_EOL);
}

<?php
declare(strict_types=1);

// Admin API: users, roles, folder groups, folder rules, site settings and the activity log.
// All operations require an admin session and the session's CSRF token; Api checks both before
// dispatching here.
//
// Access model:
//   folder group   a named list of folders, e.g. "clients" = /clients/acme/, /shared/brochures/
//   access         [{group, level}] on a user or a role: grants `level` on every folder of the group
//   folder rule    an explicit grant on one folder for "*" (everyone), a role or a user
//   account type   "standard" (inherits everyone/role grants) or "anon" (download-only account:
//                  sees only what was granted to the user itself, default deny)
final class Admin {
    private const MIN_PASSWORD_LENGTH = 8;
    private const MAX_PASSWORD_LENGTH = 1024;
    private const TYPES = ['standard', 'anon'];

    private AuthStore $store;

    public function __construct(private readonly Context $context) {
        $this->store = $context->get_auth_store();
    }

    public function apply(string $op, Request $request): array {
        $read_only = in_array($op, ['list', 'settings.get', 'activity.list'], true);
        Util::json_fail(Util::ERR_FAILED, 'data directory not writable: ' . $this->context->get_setup()->get('DATA_PATH'),
            !$read_only && !$this->store->is_writable());

        try {
            return match ($op) {
                'list' => $this->list(),
                'user.save' => $this->save_user($request->query_array('user')),
                'user.delete' => $this->delete_user($request->query_string('name')),
                'role.save' => $this->save_role($request->query_array('role')),
                'role.delete' => $this->delete_role($request->query_string('name')),
                'group.save' => $this->save_group($request->query_array('group')),
                'group.delete' => $this->delete_group($request->query_string('name')),
                'rule.save' => $this->save_rule($request->query_array('rule')),
                'rule.delete' => $this->delete_rule($request->query_string('path')),
                'settings.get' => $this->settings_response(),
                'settings.save' => $this->save_settings($request->query_array('settings')),
                'activity.list' => $this->activity($request),
                'access.check' => $this->check_access($request->query_string('principal'), $request->query_string('path')),
                default => Util::json_exit(['err' => Util::ERR_UNSUPPORTED, 'msg' => 'unsupported admin op'], 400)
            };
        } catch (InvalidArgumentException $err) {
            Util::json_exit(['err' => Util::ERR_ILLEGAL_PARAM, 'msg' => $err->getMessage()], 400);
        }
    }

    private static function access_list(mixed $access): array {
        $out = [];
        foreach (is_array($access) ? $access : [] as $entry) {
            if (is_array($entry) && is_string($entry['group'] ?? null) && is_string($entry['level'] ?? null)) {
                $out[] = ['group' => $entry['group'], 'level' => $entry['level']];
            }
        }
        return $out;
    }

    public function list(): array {
        $data = $this->store->load();
        $users = [];
        foreach ($data['users'] as $name => $user) {
            $users[] = [
                'name' => (string) $name,
                'type' => ($user['type'] ?? 'standard') === 'anon' ? 'anon' : 'standard',
                'roles' => array_values((array) ($user['roles'] ?? [])),
                'access' => Admin::access_list($user['access'] ?? []),
                'disabled' => !empty($user['disabled']),
                'created' => $user['created'] ?? null,
                'lastLogin' => $user['lastLogin'] ?? null
            ];
        }
        $roles = [];
        foreach ($data['roles'] as $name => $role) {
            $roles[] = [
                'name' => (string) $name,
                'description' => (string) ($role['description'] ?? ''),
                'builtin' => !empty($role['builtin']),
                'access' => Admin::access_list($role['access'] ?? [])
            ];
        }
        $groups = [];
        foreach ($data['groups'] as $name => $group) {
            $members = [];
            foreach ($data['users'] as $user_name => $user) {
                foreach (Admin::access_list($user['access'] ?? []) as $entry) {
                    if ($entry['group'] === (string) $name) {
                        $members[] = ['kind' => 'user', 'name' => (string) $user_name, 'level' => $entry['level']];
                    }
                }
            }
            foreach ($data['roles'] as $role_name => $role) {
                foreach (Admin::access_list($role['access'] ?? []) as $entry) {
                    if ($entry['group'] === (string) $name) {
                        $members[] = ['kind' => 'role', 'name' => (string) $role_name, 'level' => $entry['level']];
                    }
                }
            }
            $paths = array_values(array_filter((array) ($group['paths'] ?? []), 'is_string'));
            $groups[] = [
                'name' => (string) $name,
                'description' => (string) ($group['description'] ?? ''),
                'paths' => $paths,
                'missing' => array_values(array_filter($paths, function ($p) {
                    $dir = $this->context->decoded_to_path($p);
                    return $dir === null || !is_dir($dir);
                })),
                'members' => $members
            ];
        }
        $rules = [];
        foreach ($data['rules'] as $rule) {
            $path = (string) $rule['path'];
            $dir = $this->context->decoded_to_path($path);
            $rules[] = ['path' => $path, 'grants' => (object) $rule['grants'], 'exists' => $dir !== null && is_dir($dir)];
        }
        usort($rules, fn ($a, $b) => strcmp($a['path'], $b['path']));

        return [
            'users' => $users,
            'roles' => $roles,
            'groups' => $groups,
            'rules' => $rules,
            'levels' => array_keys(Acl::LEVELS),
            'types' => Admin::TYPES,
            'writable' => $this->store->is_writable(),
            'bootstrap' => $this->context->is_bootstrap_possible()
        ];
    }

    private static function check(bool $cond, string $msg): void {
        if (!$cond) {
            throw new InvalidArgumentException($msg);
        }
    }

    private static function enabled_admins(array $data, ?string $except = null): int {
        $count = 0;
        foreach ($data['users'] as $name => $user) {
            if ((string) $name !== $except && empty($user['disabled']) && ($user['type'] ?? 'standard') !== 'anon'
                && in_array('admin', (array) ($user['roles'] ?? []), true)) {
                $count += 1;
            }
        }
        return $count;
    }

    // Validates [{group, level}] against the known groups.
    private static function clean_access(array $data, mixed $access): array {
        Admin::check($access === null || is_array($access), 'access must be a list');
        $clean = [];
        foreach ($access ?? [] as $entry) {
            Admin::check(is_array($entry), 'invalid access entry');
            $group = $entry['group'] ?? null;
            $level = $entry['level'] ?? null;
            Admin::check(is_string($group) && isset($data['groups'][$group]), 'unknown folder group: ' . (is_string($group) ? $group : '?'));
            Admin::check(is_string($level) && isset(Acl::LEVELS[$level]), 'invalid level for folder group ' . $group);
            $clean[$group] = ['group' => $group, 'level' => $level]; // one entry per group
        }
        return array_values($clean);
    }

    private static function clean_path(mixed $path): string {
        Admin::check(is_string($path) && $path !== '' && !str_contains($path, "\0"), 'invalid path');
        Admin::check(!in_array('..', explode('/', str_replace('\\', '/', $path)), true), 'invalid path');
        return Acl::normalize_path($path);
    }

    private static function bump(array &$record): void {
        $record['version'] = (int) ($record['version'] ?? 0) + 1;
    }

    private function save_user(array $input): array {
        $name = $input['name'] ?? null;
        Admin::check(is_string($name) && preg_match(AuthStore::NAME_RE, $name) === 1,
            'invalid user name (letters, digits and . _ @ -, max 64 chars)');
        $password = $input['password'] ?? null;
        Admin::check($password === null || $password === '' || (is_string($password)
            && mb_strlen($password) >= Admin::MIN_PASSWORD_LENGTH && strlen($password) <= Admin::MAX_PASSWORD_LENGTH),
            'password must have at least ' . Admin::MIN_PASSWORD_LENGTH . ' characters');
        $roles = $input['roles'] ?? [];
        Admin::check(is_array($roles), 'roles must be a list');
        $type = $input['type'] ?? null;
        Admin::check($type === null || in_array($type, Admin::TYPES, true), 'type must be "standard" or "anon"');
        $disabled = ($input['disabled'] ?? false) === true;
        $create = ($input['create'] ?? false) === true;
        $has_access = array_key_exists('access', $input);

        $this->store->update(function ($data) use ($name, $password, $roles, $type, $disabled, $create, $has_access, $input) {
            $admins_before = Admin::enabled_admins($data);
            $exists = isset($data['users'][$name]);
            Admin::check(!($create && $exists), 'user already exists');
            Admin::check($exists || (is_string($password) && $password !== ''), 'a password is required for new users');
            foreach ($roles as $role) {
                Admin::check(is_string($role) && isset($data['roles'][$role]), 'unknown role: ' . (is_string($role) ? $role : '?'));
            }
            $roles = array_values(array_unique($roles));

            $user = $exists ? $data['users'][$name] : ['created' => time(), 'lastLogin' => null, 'version' => 0, 'type' => 'standard', 'access' => []];
            $type = $type ?? ($user['type'] ?? 'standard');
            // anon accounts are download-only: no roles at all, especially not admin
            if ($type === 'anon') {
                $roles = [];
            }
            $access = $has_access ? Admin::clean_access($data, $input['access']) : Admin::access_list($user['access'] ?? []);

            $changed = !$exists
                || ($user['roles'] ?? []) !== $roles
                || ($user['type'] ?? 'standard') !== $type
                || ($user['access'] ?? []) !== $access
                || !empty($user['disabled']) !== $disabled
                || (is_string($password) && $password !== '');

            $user['type'] = $type;
            $user['roles'] = $roles;
            $user['access'] = $access;
            $user['disabled'] = $disabled;
            if (is_string($password) && $password !== '') {
                $user['hash'] = password_hash($password, PASSWORD_DEFAULT);
            }
            if ($changed && $exists) {
                Admin::bump($user); // invalidates existing sessions of this user
            }
            $data['users'][$name] = $user;

            // never remove the last enabled admin (while none exists the bootstrap login still works)
            Admin::check($admins_before === 0 || Admin::enabled_admins($data) > 0, 'at least one enabled admin is required');
            return $data;
        });

        return $this->list();
    }

    private function delete_user(string $name): array {
        $current = $this->context->get_user();
        Admin::check($current === null || $current['name'] !== $name || $current['bootstrap'], 'you can not delete yourself');
        $this->store->update(function ($data) use ($name) {
            Admin::check(isset($data['users'][$name]), 'unknown user');
            $admins_before = Admin::enabled_admins($data);
            unset($data['users'][$name]);
            Admin::check($admins_before === 0 || Admin::enabled_admins($data) > 0, 'at least one enabled admin is required');
            foreach ($data['rules'] as &$rule) {
                unset($rule['grants']['user:' . $name]);
            }
            unset($rule);
            return $data;
        });
        return $this->list();
    }

    private function save_role(array $input): array {
        $name = $input['name'] ?? null;
        Admin::check(is_string($name) && preg_match(AuthStore::NAME_RE, $name) === 1, 'invalid role name');
        $description = is_string($input['description'] ?? null) ? mb_substr($input['description'], 0, 200) : null;
        $has_access = array_key_exists('access', $input);
        $this->store->update(function ($data) use ($name, $description, $has_access, $input) {
            $role = $data['roles'][$name] ?? ['description' => '', 'access' => []];
            if ($description !== null) {
                $role['description'] = $description;
            }
            if ($has_access) {
                $role['access'] = Admin::clean_access($data, $input['access']);
            }
            $data['roles'][$name] = $role;
            return $data;
        });
        return $this->list();
    }

    private function delete_role(string $name): array {
        $this->store->update(function ($data) use ($name) {
            Admin::check(isset($data['roles'][$name]), 'unknown role');
            Admin::check(empty($data['roles'][$name]['builtin']), 'built-in roles can not be deleted');
            unset($data['roles'][$name]);
            foreach ($data['users'] as &$user) {
                $roles = array_values(array_diff((array) ($user['roles'] ?? []), [$name]));
                if ($roles !== ($user['roles'] ?? [])) {
                    $user['roles'] = $roles;
                    Admin::bump($user);
                }
            }
            unset($user);
            foreach ($data['rules'] as &$rule) {
                unset($rule['grants']['role:' . $name]);
            }
            unset($rule);
            return $data;
        });
        return $this->list();
    }

    private function save_group(array $input): array {
        $name = $input['name'] ?? null;
        Admin::check(is_string($name) && preg_match(AuthStore::NAME_RE, $name) === 1,
            'invalid folder group name (letters, digits and . _ @ -, max 64 chars)');
        $description = is_string($input['description'] ?? null) ? mb_substr($input['description'], 0, 200) : '';
        $paths = $input['paths'] ?? [];
        Admin::check(is_array($paths), 'paths must be a list');
        $clean = [];
        foreach ($paths as $path) {
            $clean[] = Admin::clean_path($path);
        }
        $clean = array_values(array_unique($clean));
        Admin::check(count($clean) <= 500, 'too many folders in one group');
        $rename_from = is_string($input['renameFrom'] ?? null) ? $input['renameFrom'] : null;

        $this->store->update(function ($data) use ($name, $description, $clean, $rename_from) {
            if ($rename_from !== null && $rename_from !== $name) {
                Admin::check(isset($data['groups'][$rename_from]), 'unknown folder group');
                Admin::check(!isset($data['groups'][$name]), 'a folder group with this name exists');
                unset($data['groups'][$rename_from]);
                foreach (['users', 'roles'] as $kind) {
                    foreach ($data[$kind] as &$record) {
                        foreach ($record['access'] ?? [] as $i => $entry) {
                            if (($entry['group'] ?? null) === $rename_from) {
                                $record['access'][$i]['group'] = $name;
                            }
                        }
                    }
                    unset($record);
                }
            }
            $data['groups'][$name] = ['description' => $description, 'paths' => $clean];
            return $data;
        });
        return $this->list();
    }

    private function delete_group(string $name): array {
        $this->store->update(function ($data) use ($name) {
            Admin::check(isset($data['groups'][$name]), 'unknown folder group');
            unset($data['groups'][$name]);
            foreach (['users', 'roles'] as $kind) {
                foreach ($data[$kind] as &$record) {
                    $access = array_values(array_filter((array) ($record['access'] ?? []), fn ($e) => ($e['group'] ?? null) !== $name));
                    if ($access !== ($record['access'] ?? [])) {
                        $record['access'] = $access;
                        if ($kind === 'users') {
                            Admin::bump($record);
                        }
                    }
                }
                unset($record);
            }
            return $data;
        });
        return $this->list();
    }

    private function save_rule(array $input): array {
        $path = Admin::clean_path($input['path'] ?? null);
        $grants = $input['grants'] ?? [];
        Admin::check(is_array($grants), 'grants must be an object');

        $this->store->update(function ($data) use ($path, $grants) {
            $clean = [];
            foreach ($grants as $key => $level) {
                Admin::check(is_string($level) && isset(Acl::LEVELS[$level]), 'invalid level for ' . $key);
                $key = (string) $key;
                if ($key === '*') {
                    $clean[$key] = $level;
                } elseif (str_starts_with($key, 'role:')) {
                    Admin::check(isset($data['roles'][substr($key, 5)]), 'unknown role in ' . $key);
                    $clean[$key] = $level;
                } elseif (str_starts_with($key, 'user:')) {
                    Admin::check(isset($data['users'][substr($key, 5)]), 'unknown user in ' . $key);
                    $clean[$key] = $level;
                } else {
                    Admin::check(false, 'invalid grant key: ' . $key);
                }
            }

            $rules = array_values(array_filter($data['rules'], fn ($r) => Acl::normalize_path((string) ($r['path'] ?? '')) !== $path));
            if ($clean) {
                $rules[] = ['path' => $path, 'grants' => $clean];
            }
            $data['rules'] = $rules;
            return $data;
        });
        return $this->list();
    }

    private function delete_rule(string $path): array {
        $path = Acl::normalize_path($path);
        $this->store->update(function ($data) use ($path) {
            $data['rules'] = array_values(array_filter($data['rules'], fn ($r) => Acl::normalize_path((string) ($r['path'] ?? '')) !== $path));
            return $data;
        });
        return $this->list();
    }

    private function save_settings(array $input): array {
        Admin::check($this->context->get_settings()->is_writable(), 'data directory not writable');
        $settings = $this->context->get_settings();
        $settings->save($input);
        // show the effect of new proxy settings on this very request
        $this->context->get_request()->configure_proxy((array) $settings->get('proxy.trusted', []), (string) $settings->get('proxy.publicUrl', ''));
        return $this->settings_response();
    }

    // Settings plus how h6ai sees the admin's own request, to set up a reverse proxy.
    private function settings_response(): array {
        $request = $this->context->get_request();
        return [
            'settings' => $this->context->get_settings()->to_admin(),
            'request' => [
                'remoteAddr' => $request->remote_addr(),
                'clientIp' => $request->client_ip(),
                'fromTrustedProxy' => $request->from_trusted_proxy(),
                'forwardedFor' => $request->header('X-Forwarded-For'),
                'forwardedProto' => $request->header('X-Forwarded-Proto'),
                'forwardedHost' => $request->header('X-Forwarded-Host'),
                'host' => $request->header('Host'),
                'https' => $request->is_https(),
                'publicOrigin' => $request->public_origin()
            ]
        ];
    }

    // Effective access of a user (or everyone, "*") on a folder, with the rule that decided it.
    private function check_access(string $principal, string $path): array {
        $path = Admin::clean_path($path);
        $data = $this->store->load();
        if ($principal === '*') {
            $acl = new Acl($this->store->get_effective_rules(), null, []);
            $who = 'Everyone (not logged in)';
        } else {
            $name = str_starts_with($principal, 'user:') ? substr($principal, 5) : $principal;
            $user = $data['users'][$name] ?? null;
            Admin::check(is_array($user), 'unknown user');
            $anon = ($user['type'] ?? 'standard') === 'anon';
            $acl = new Acl($this->store->get_effective_rules(), $name, $anon ? [] : (array) ($user['roles'] ?? []), $anon);
            $who = $name;
        }
        $explain = $acl->explain($path);
        $dir = $this->context->decoded_to_path($path);
        return ['access' => [
            'who' => $who,
            'path' => $path,
            'exists' => $dir !== null && is_dir($dir),
            'level' => array_search($explain['level'], Acl::LEVELS, true),
            'reachable' => $acl->is_reachable($path),
            'reason' => $explain['reason'],
            'rule' => $explain['rule'] ?? null
        ]];
    }

    private function activity(Request $request): array {
        $limit = Util::to_int($request->query('limit', 200), 1, 2000) ?? 200;
        $filter = fn ($key) => is_string($v = $request->query($key, null)) ? $v : null;
        return (new ActivityLog($this->context))->query($limit, $filter('user'), $filter('kind'), $filter('path'));
    }

    // Any logged in standard user can change their own password.
    public function change_own_password(string $current_pass, string $new_pass): bool {
        $user = $this->context->get_user();
        Admin::check($user !== null && !$user['bootstrap'], 'not logged in as a regular user');
        Admin::check(mb_strlen($new_pass) >= Admin::MIN_PASSWORD_LENGTH && strlen($new_pass) <= Admin::MAX_PASSWORD_LENGTH,
            'password must have at least ' . Admin::MIN_PASSWORD_LENGTH . ' characters');
        $record = $this->store->get_user($user['name']);
        if ($record === null || !password_verify($current_pass, (string) ($record['hash'] ?? ''))) {
            return false;
        }
        $data = $this->store->update(function ($data) use ($user, $new_pass) {
            $data['users'][$user['name']]['hash'] = password_hash($new_pass, PASSWORD_DEFAULT);
            Admin::bump($data['users'][$user['name']]);
            return $data;
        });
        // keep the current session alive with the new version
        $this->context->get_session()->set('USER_VER', (int) $data['users'][$user['name']]['version']);
        return true;
    }
}

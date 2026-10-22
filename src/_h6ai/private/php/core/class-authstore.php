<?php
declare(strict_types=1);

// Users, roles and folder permission rules, stored in private/data/auth.json.
// Writers serialise on a lock file and replace auth.json atomically (rename), so readers never
// see a half written file and don't need a lock.
final class AuthStore {
    public const NAME_RE = '/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/';
    private const BUILTIN_ROLES = [
        'admin' => 'Full access to all folders, manages users and permissions',
        'user' => 'Default role for new users'
    ];

    private JsonStore $store;
    private ?array $data = null;

    public function __construct(string $data_path, string $cache_path) {
        $this->store = new JsonStore($data_path . '/auth.json', $cache_path);
    }

    public static function initial(): array {
        $roles = [];
        foreach (AuthStore::BUILTIN_ROLES as $name => $description) {
            $roles[$name] = ['description' => $description, 'builtin' => true, 'access' => []];
        }
        return ['version' => 1, 'users' => [], 'roles' => $roles, 'groups' => [], 'rules' => []];
    }

    private static function normalize(?array $data): array {
        $initial = AuthStore::initial();
        if (!is_array($data) || !$data) {
            return $initial;
        }
        $data['version'] = 1;
        foreach (['users', 'groups', 'rules'] as $key) {
            $data[$key] = is_array($data[$key] ?? null) ? $data[$key] : [];
        }
        $roles = is_array($data['roles'] ?? null) ? $data['roles'] : [];
        foreach ($initial['roles'] as $name => $role) {
            $roles[$name] = array_merge($role, is_array($roles[$name] ?? null) ? $roles[$name] : [], ['builtin' => true]);
        }
        $data['roles'] = $roles;
        return $data;
    }

    public function is_writable(): bool {
        return $this->store->is_writable();
    }

    public function load(): array {
        if ($this->data === null) {
            $this->data = AuthStore::normalize($this->store->load());
        }
        return $this->data;
    }

    // Runs $fn(data) under an exclusive lock and persists the returned data.
    public function update(callable $fn): array {
        $this->data = $this->store->update(fn ($current) => AuthStore::normalize($fn(AuthStore::normalize($current))));
        return $this->data;
    }

    public function has_users(): bool {
        return count($this->load()['users']) > 0;
    }

    public function has_admin_user(): bool {
        foreach ($this->load()['users'] as $user) {
            if (empty($user['disabled']) && in_array('admin', (array) ($user['roles'] ?? []), true)) {
                return true;
            }
        }
        return false;
    }

    public function get_user(string $name): ?array {
        $user = $this->load()['users'][$name] ?? null;
        return is_array($user) ? $user : null;
    }

    public function get_rules(): array {
        return $this->load()['rules'];
    }

    // Explicit folder rules plus the grants that follow from folder group assignments of users
    // ("user:<name>") and roles ("role:<name>"). Same path and principal: the higher level wins.
    public function get_effective_rules(): array {
        $data = $this->load();
        $by_path = [];
        $add = function (string $path, string $key, string $level) use (&$by_path) {
            if (!isset(Acl::LEVELS[$level])) {
                return;
            }
            $path = Acl::normalize_path($path);
            $current = $by_path[$path][$key] ?? null;
            if ($current === null || Acl::LEVELS[$level] > Acl::LEVELS[$current]) {
                $by_path[$path][$key] = $level;
            }
        };

        foreach ($data['rules'] as $rule) {
            if (is_array($rule) && is_string($rule['path'] ?? null) && is_array($rule['grants'] ?? null)) {
                foreach ($rule['grants'] as $key => $level) {
                    $add($rule['path'], (string) $key, (string) $level);
                }
            }
        }

        $assign = function (string $key, mixed $access) use ($data, $add) {
            foreach (is_array($access) ? $access : [] as $entry) {
                $group = $data['groups'][$entry['group'] ?? ''] ?? null;
                if (!is_array($group)) {
                    continue;
                }
                foreach ((array) ($group['paths'] ?? []) as $path) {
                    if (is_string($path)) {
                        $add($path, $key, (string) ($entry['level'] ?? ''));
                    }
                }
            }
        };
        foreach ($data['users'] as $name => $user) {
            $assign('user:' . $name, $user['access'] ?? []);
        }
        foreach ($data['roles'] as $name => $role) {
            $assign('role:' . $name, $role['access'] ?? []);
        }

        $rules = [];
        foreach ($by_path as $path => $grants) {
            $rules[] = ['path' => $path, 'grants' => $grants];
        }
        return $rules;
    }
}

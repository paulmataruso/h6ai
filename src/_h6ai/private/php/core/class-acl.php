<?php
declare(strict_types=1);

// Folder permissions.
//
// Rules attach grants to folder paths (decoded, relative to the h6ai root, e.g. "/team/docs/").
// The most specific rule that has a grant for the principal decides:
//   - a "user:<name>" grant wins over role grants of the same rule,
//   - otherwise the highest of the matching "role:<name>" and "*" (everyone) grants applies,
//   - rules without a matching grant are skipped, falling back to less specific rules.
// Without any applicable rule the default level is "download" (classic, open h6ai).
// Members of the "admin" role always have full access.
//
// "anon" accounts are download-only accounts: they ignore "*" and role grants, only grants made
// to the user directly (usually through folder group assignments) count, and the default is
// "none". So they see nothing but the folders that were explicitly shared with them.
final class Acl {
    public const NONE = 0;
    public const LIST = 1;
    public const READ = 2;
    public const DOWNLOAD = 3;
    public const LEVELS = ['none' => Acl::NONE, 'list' => Acl::LIST, 'read' => Acl::READ, 'download' => Acl::DOWNLOAD];

    private array $rules = [];
    private array $cache = [];

    public function __construct(
        array $rules,
        private readonly ?string $user,
        private readonly array $roles,
        private readonly bool $anon = false
    ) {
        foreach ($rules as $rule) {
            if (is_array($rule) && is_string($rule['path'] ?? null) && is_array($rule['grants'] ?? null)) {
                $this->rules[Acl::normalize_path($rule['path'])] = $rule['grants'];
            }
        }
        // most specific first
        uksort($this->rules, fn ($a, $b) => strlen($b) <=> strlen($a));
    }

    public static function normalize_path(string $path): string {
        $segments = array_filter(explode('/', str_replace('\\', '/', $path)), fn ($s) => $s !== '' && $s !== '.');
        return $segments ? '/' . implode('/', $segments) . '/' : '/';
    }

    public function is_enabled(): bool {
        return $this->anon || count($this->rules) > 0;
    }

    public function is_anon(): bool {
        return $this->anon;
    }

    public function is_admin(): bool {
        return !$this->anon && in_array('admin', $this->roles, true);
    }

    private function grant_level(array $grants): ?int {
        if ($this->user !== null && isset($grants['user:' . $this->user])) {
            return Acl::LEVELS[$grants['user:' . $this->user]] ?? Acl::NONE;
        }
        if ($this->anon) {
            return null;
        }
        $level = null;
        $keys = ['*'];
        foreach ($this->roles as $role) {
            $keys[] = 'role:' . $role;
        }
        foreach ($keys as $key) {
            if (isset($grants[$key])) {
                $level = max($level ?? Acl::NONE, Acl::LEVELS[$grants[$key]] ?? Acl::NONE);
            }
        }
        return $level;
    }

    // Access level for a folder given as root relative path.
    public function level(string $rel_dir): int {
        if ($this->is_admin() || !$this->is_enabled()) {
            return Acl::DOWNLOAD;
        }
        $rel_dir = Acl::normalize_path($rel_dir);
        if (isset($this->cache[$rel_dir])) {
            return $this->cache[$rel_dir];
        }

        $level = $this->anon ? Acl::NONE : Acl::DOWNLOAD;
        foreach ($this->rules as $path => $grants) {
            if (str_starts_with($rel_dir, $path)) {
                $granted = $this->grant_level($grants);
                if ($granted !== null) {
                    $level = $granted;
                    break;
                }
            }
        }
        return $this->cache[$rel_dir] = $level;
    }

    // The level plus the rule and grant that decided it, for the admin's access checker.
    public function explain(string $rel_dir): array {
        $rel_dir = Acl::normalize_path($rel_dir);
        if ($this->is_admin()) {
            return ['level' => Acl::DOWNLOAD, 'reason' => 'admin'];
        }
        if (!$this->is_enabled()) {
            return ['level' => Acl::DOWNLOAD, 'reason' => 'no rules'];
        }
        foreach ($this->rules as $path => $grants) {
            if (str_starts_with($rel_dir, $path)) {
                $granted = $this->grant_level($grants);
                if ($granted !== null) {
                    return ['level' => $granted, 'reason' => 'rule', 'rule' => $path];
                }
            }
        }
        return ['level' => $this->anon ? Acl::NONE : Acl::DOWNLOAD, 'reason' => $this->anon ? 'anon default' : 'default'];
    }

    // A folder is reachable if it can be listed itself, or if some rule below it grants listing.
    // Reachable folders are shown in their parent listing so users can navigate to them.
    public function is_reachable(string $rel_dir): bool {
        $rel_dir = Acl::normalize_path($rel_dir);
        if ($this->level($rel_dir) >= Acl::LIST) {
            return true;
        }
        foreach (array_keys($this->rules) as $path) {
            if ($path !== $rel_dir && str_starts_with($path, $rel_dir) && $this->level($path) >= Acl::LIST) {
                return true;
            }
        }
        return false;
    }

    // Whether anonymous visitors could read files in this folder; used for cache headers.
    public static function is_public(array $rules, string $rel_dir): bool {
        return (new Acl($rules, null, []))->level($rel_dir) >= Acl::READ;
    }
}

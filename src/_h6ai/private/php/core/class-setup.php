<?php
declare(strict_types=1);

final class Setup {
    private const CMDS = ['avconv', 'convert', 'du', 'ffmpeg', 'gm', 'gs', 'magick', 'tar', 'timeout', 'zip'];

    private array $store = [];

    public function __construct(private readonly bool $refresh = false) {
        $this->add_globals_and_envs();
        $this->add_php_checks();
        $this->add_app_metadata();
        $this->add_server_metadata_and_check();
        $this->add_paths();
        $this->add_php_fix_check();
        $this->add_sys_cmd_checks();
    }

    private function set(string $key, string|bool $value): void {
        if (array_key_exists($key, $this->store)) {
            throw new LogicException('setup key already taken: ' . $key);
        }
        $this->store[$key] = $value;
    }

    public function get(string $key): string|bool {
        if (!array_key_exists($key, $this->store)) {
            throw new LogicException('setup key not found: ' . $key);
        }
        return $this->store[$key];
    }

    // CVE-2026-109618 (RCE via OOM corruption) is fixed in 8.2.35, 8.3.36, 8.4.27 and 8.5.12.
    public static function is_php_patched(string $version): bool {
        $fixed = ['8.2' => '8.2.35', '8.3' => '8.3.36', '8.4' => '8.4.27', '8.5' => '8.5.12'];
        $branch = implode('.', array_slice(explode('.', $version), 0, 2));
        if (isset($fixed[$branch])) {
            return version_compare($version, $fixed[$branch], '>=');
        }
        return version_compare($version, '8.6.0', '>=');
    }

    // Distributions backport security fixes without changing PHP_VERSION: Ubuntu 24.04 ships the
    // fix in its 8.3.6 package. Debian and Ubuntu name the CVE in the package changelog.
    public static function has_backported_fix(string $version): bool {
        $branch = implode('.', array_slice(explode('.', $version), 0, 2));
        $changelog = '/usr/share/doc/php' . $branch . '-common/changelog.Debian.gz';
        $gz = function_exists('gzopen') && @is_readable($changelog) ? @gzopen($changelog, 'rb') : false;
        if ($gz === false) {
            return false;
        }
        $found = false;
        while (!$found && ($line = gzgets($gz, 8192)) !== false) {
            $found = str_contains($line, 'CVE-2026-109618');
        }
        gzclose($gz);
        return $found;
    }

    private static function server_var(string $key): string {
        $value = $_SERVER[$key] ?? '';
        return is_string($value) ? $value : '';
    }

    private function add_globals_and_envs(): void {
        $this->set('PHP_VERSION', PHP_VERSION);
        $this->set('MIN_PHP_VERSION', MIN_PHP_VERSION);
        $this->set('PHP_ARCH', (PHP_INT_SIZE * 8) . '-bit');

        $this->set('REQUEST_METHOD', Setup::server_var('REQUEST_METHOD') ?: 'GET');
        $this->set('REQUEST_HREF', (string) parse_url(Setup::server_var('REQUEST_URI') ?: '/', PHP_URL_PATH));
        $this->set('SCRIPT_NAME', Setup::server_var('SCRIPT_NAME'));
        $this->set('SERVER_SOFTWARE', Setup::server_var('SERVER_SOFTWARE'));
        $this->set('HTTP_USER_AGENT', Setup::server_var('HTTP_USER_AGENT'));
    }

    private function add_php_checks(): void {
        $this->set('HAS_PHP_EXIF', function_exists('exif_thumbnail') && function_exists('exif_read_data'));

        $infos = function_exists('gd_info') ? gd_info() : [];
        $this->set('HAS_PHP_JPEG', !empty($infos['JPEG Support']));
        $this->set('HAS_PHP_WEBP', !empty($infos['WebP Support']));
        $this->set('HAS_PHP_AVIF', !empty($infos['AVIF Support']));
    }

    private function add_app_metadata(): void {
        $this->set('NAME', 'h6ai');
        $this->set('VERSION', H6AI_VERSION);
        $this->set('FILE_PREFIX', '_h6ai');
    }

    private function add_server_metadata_and_check(): void {
        $server_software = $this->get('SERVER_SOFTWARE');
        $server_name = '';
        $server_version = '';

        if ($server_software && preg_match('#^(.*?)(?:/(.*?))?(?: |$)#', strtolower($server_software), $matches)) {
            $server_name = $matches[1];
            $server_version = $matches[2] ?? '';
        }

        $this->set('SERVER_NAME', $server_name);
        $this->set('SERVER_VERSION', $server_version);
        $this->set('HAS_SERVER', in_array($server_name, ['apache', 'caddy', 'cherokee', 'lighttpd', 'litespeed', 'nginx', 'openlitespeed'], true));
    }

    private function add_paths(): void {
        $script_name = $this->get('SCRIPT_NAME');
        if ($this->get('SERVER_NAME') === 'lighttpd') {
            $script_name = preg_replace('#^.*?//#', '/', $script_name);
        }

        $this->set('H6AI_HREF', Util::normalize_path(dirname($script_name, 2), true));
        $this->set('H6AI_PATH', Util::normalize_path(dirname(__FILE__, 4), false));

        $this->set('ROOT_HREF', Util::normalize_path(dirname($this->get('H6AI_HREF')), true));
        $this->set('ROOT_PATH', Util::normalize_path(dirname($this->get('H6AI_PATH')), false));

        $this->set('PUBLIC_HREF', Util::normalize_path($this->get('H6AI_HREF') . '/public/', true));
        $this->set('PUBLIC_PATH', Util::normalize_path($this->get('H6AI_PATH') . '/public/', false));

        $this->set('INDEX_HREF', Util::normalize_path($this->get('PUBLIC_HREF') . '/index.php', false));
        $this->set('CACHE_PUB_HREF', Util::normalize_path($this->get('PUBLIC_HREF') . '/cache', true));
        $this->set('CACHE_PUB_PATH', Util::normalize_path($this->get('PUBLIC_PATH') . '/cache', false));
        $this->set('HAS_WRITABLE_CACHE_PUB', @is_writable($this->get('CACHE_PUB_PATH')));

        $this->set('PRIVATE_PATH', Util::normalize_path($this->get('H6AI_PATH') . '/private', false));
        $this->set('CONF_PATH', Util::normalize_path($this->get('PRIVATE_PATH') . '/conf', false));
        $this->set('CACHE_PRV_PATH', Util::normalize_path($this->get('PRIVATE_PATH') . '/cache', false));
        $this->set('HAS_WRITABLE_CACHE_PRV', @is_writable($this->get('CACHE_PRV_PATH')));
        $this->set('DATA_PATH', Util::normalize_path($this->get('PRIVATE_PATH') . '/data', false));
        $this->set('HAS_WRITABLE_DATA', @is_writable($this->get('DATA_PATH')));
    }

    private function add_php_fix_check(): void {
        $fix = Setup::is_php_patched(PHP_VERSION) ? 'version' : '';
        if ($fix === '') {
            // the changelog only changes with a package update: cache the answer per version
            $cache_path = Util::normalize_path($this->get('CACHE_PRV_PATH') . '/php-fix.json', false);
            $cached = Json::load($cache_path) ?? [];
            if (($cached['version'] ?? null) === PHP_VERSION && is_bool($cached['backport'] ?? null)) {
                $backport = $cached['backport'];
            } else {
                $backport = Setup::has_backported_fix(PHP_VERSION);
                Json::save($cache_path, ['version' => PHP_VERSION, 'backport' => $backport]);
            }
            $fix = $backport ? 'backport' : '';
        }
        $this->set('PHP_CVE_2026_109618_FIXED', $fix !== '');
        $this->set('PHP_CVE_2026_109618_FIX', $fix);
    }

    private function add_sys_cmd_checks(): void {
        $cmds_cache_path = Util::normalize_path($this->get('CACHE_PRV_PATH') . '/cmds.json', false);

        $cmds = Json::load($cmds_cache_path) ?? [];
        $is_complete = count(array_diff(Setup::CMDS, array_keys($cmds))) === 0;
        if (!$is_complete || $this->refresh) {
            $cmds = [];
            $lookup = false;
            if (Util::exec_0('command -v command')) {
                $lookup = 'command -v';
            } elseif (Util::exec_0('which which')) {
                $lookup = 'which';
            } elseif (Util::exec_0('where where.exe')) {
                $lookup = 'where';
            }

            foreach (Setup::CMDS as $c) {
                $cmds[$c] = $lookup !== false && (Util::exec_0($lookup . ' ' . $c) || Util::exec_0($lookup . ' ' . $c . '.exe'));
            }

            Json::save($cmds_cache_path, $cmds);
        }
        foreach (Setup::CMDS as $c) {
            $this->set('HAS_CMD_' . strtoupper($c), ($cmds[$c] ?? false) === true);
        }
    }

    public function to_jsono(bool $as_admin = false): array {
        $keys = [
            'PUBLIC_HREF',
            'ROOT_HREF'
        ];

        if ($as_admin) {
            $keys = array_merge($keys, [
                'VERSION',

                'PHP_VERSION',
                'MIN_PHP_VERSION',
                'PHP_ARCH',
                'PHP_CVE_2026_109618_FIXED',
                'PHP_CVE_2026_109618_FIX',
                'HAS_PHP_EXIF',
                'HAS_PHP_JPEG',
                'HAS_PHP_WEBP',
                'HAS_PHP_AVIF',

                'SERVER_NAME',
                'SERVER_VERSION',
                'HAS_SERVER',

                'INDEX_HREF',

                'HAS_WRITABLE_CACHE_PUB',
                'HAS_WRITABLE_CACHE_PRV',
                'HAS_WRITABLE_DATA',

                'HAS_CMD_AVCONV',
                'HAS_CMD_CONVERT',
                'HAS_CMD_DU',
                'HAS_CMD_FFMPEG',
                'HAS_CMD_GM',
                'HAS_CMD_GS',
                'HAS_CMD_MAGICK',
                'HAS_CMD_TAR',
                'HAS_CMD_TIMEOUT',
                'HAS_CMD_ZIP'
            ]);
        }

        $jsono = ['AS_ADMIN' => $as_admin];
        foreach ($keys as $key) {
            $jsono[$key] = $this->get($key);
        }
        return $jsono;
    }
}

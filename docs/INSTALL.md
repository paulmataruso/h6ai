# Installing h6ai

There are two supported ways to run h6ai, and you pick one:

* **Native**: h6ai runs directly on the server's operating system (bare metal or a VM) with the
  distribution's nginx and PHP-FPM. No Docker involved. `install.sh` does the setup.
* **Docker**: h6ai runs in a container that brings its own nginx and PHP-FPM.

The installer in the release bundle does either one and asks which:

```sh
tar xzf h6ai-1.0.0.tar.gz
cd h6ai-1.0.0
sudo ./install.sh              # 1) natively on this system  2) in Docker
```

`sudo ./install.sh --native` or `--docker` skips the question. The release bundle is made with
`npm run release` (`build/h6ai-<version>.tar.gz`). From a git checkout, run `npm ci && npm run
build` first.

Both use the same nginx and PHP configuration (`deploy/`), so they get the same permission gate,
large-file tuning and security hardening.

| | Native | Docker |
|---|---|---|
| What you get | nginx and PHP-FPM on the host OS, set up by `install.sh` | one container with nginx and PHP-FPM |
| Good for | a dedicated server or VM, hosts without Docker | any host that runs Docker; keeps the host clean |
| PHP | the distribution's PHP, checked for the CVE fix | pinned in the image (8.3.36, fixed for CVE-2026-109618) |
| Your files | any folder on the host | a host folder mounted into the container |
| Upgrade | run `install.sh` from the new release | `git pull`, `docker compose up -d --build` |

Both install the application into a hidden `_h6ai` folder inside the shared folder. Your own files
are never modified.

* [Native install](#native-install) (bare metal or VM)
* [Docker](#docker)
* [Managing users from the shell](#managing-users-from-the-shell)
* [Running h6ai on an nginx you configure yourself](DEPLOYMENT.md)

## Native install

`install.sh --native` sets up nginx and PHP-FPM from the distribution's packages and installs h6ai
into the folder you share:

```sh
sudo ./install.sh --native
```

It asks for the folder to share (default `/srv/h6ai`), the port (default 80) and a password for
the first admin, then prints the URLs.

### Supported systems

Every system in this table is tested with `test-native/run.sh`. A clean container stands in for
a fresh install of the OS: the installer runs in it, then the full integration suite runs against
the result. `test-native/systemd.sh` repeats an install under a real systemd, with a reboot.

| System | PHP | CVE-2026-109618 |
|---|---|---|
| Debian 12 | 8.2.35 | fixed |
| Debian 13 | 8.4.27 | fixed |
| Ubuntu 22.04 | 8.1 is too old: `--allow-php-repo` adds `ppa:ondrej/php` (8.4.27) | fixed |
| Ubuntu 24.04 | 8.3.6 | fixed (Ubuntu backport) |
| Ubuntu 26.04 | 8.5.4 | fixed (Ubuntu backport) |
| Rocky, Alma, RHEL 9 | 8.3.36 (the installer enables the `php:8.3` module stream) | fixed |
| Fedora 44 | 8.5.12 | fixed |
| Alpine 3.22 | 8.4.27 | fixed |

The installer checks the CVE fix the same way the admin page does: by version (8.2.35, 8.3.36,
8.4.27, 8.5.12 or later) or, for Debian and Ubuntu packages that backport fixes without changing
the version, by the package changelog. It stops if PHP isn't fixed, unless you pass
`--allow-unpatched-php`.

On RHEL-family systems, video and PDF thumbnails need ffmpeg and Ghostscript from EPEL or RPM
Fusion. Without them h6ai works but shows file icons for those types; the installer lists what it
couldn't install.

### Options

| Option | |
|---|---|
| `--native`, `--docker` | how h6ai runs (asked if neither is given) |
| `--root DIR` | folder to share (default `/srv/h6ai`) |
| `--port N` | HTTP port (default 80) |
| `--listen ADDR` | listen on one address only, e.g. `192.168.1.10` (default: all) |
| `--server-name NAMES` | nginx `server_name`, e.g. `files.example.com`. Without it h6ai is the default site for its port. |
| `--admin NAME` | name of the first admin (default `admin`) |
| `--admin-password-file F` | read the first admin's password from a file |
| `--no-admin` | don't create an admin; do it later with `h6ai-user add NAME --admin` |
| `--no-thumbnail-tools` | skip ffmpeg, ImageMagick and Ghostscript |
| `--no-firewall` | don't open the port in firewalld or ufw |
| `--allow-php-repo` | if the distribution's PHP is older than 8.2, add Ondřej Surý's PHP repository without asking |
| `--allow-unpatched-php` | install even if PHP lacks the CVE-2026-109618 fix |
| `-y`, `--yes` | don't ask, use the defaults (a generated admin password is printed at the end) |
| `--uninstall` | remove h6ai from nginx and PHP-FPM; keep `<root>/_h6ai` |
| `--uninstall --purge` | also delete `<root>/_h6ai` (users, settings), `/var/lib/h6ai` and the `h6ai` system user |

`--root`, `--port`, `--listen`, `--admin`, `--admin-password-file`, `--yes` and `--uninstall
[--purge]` work the same with `--docker`.

Unattended example:

```sh
sudo ./install.sh --yes --root /mnt/storage/public --port 8080 --admin-password-file /root/h6ai-pass
```

### What the installer changes

* Installs `nginx`, `php-fpm` with the `gd`, `mbstring`, `opcache`, `exif` and `posix` extensions,
  `zip`, and (unless `--no-thumbnail-tools`) `ffmpeg`, ImageMagick and Ghostscript.
* Creates the system user `h6ai`. PHP-FPM runs h6ai as that user in its own pool, so other PHP
  sites on the host keep their settings. Sessions are kept in `/var/lib/h6ai/sessions`.
* Installs the application into `<root>/_h6ai`. Only `public/cache`, `private/cache` and
  `private/data` are writable for PHP.
* PHP: the pool `h6ai` (e.g. `/etc/php/8.3/fpm/pool.d/h6ai.conf`) carries the settings from
  `deploy/php/h6ai.ini` (no uploads, no multipart, streaming, sessions). OPcache, JIT and the
  realpath cache are process wide and go into `conf.d/90-h6ai.ini`.
* nginx: the shared parts go to `/etc/nginx/h6ai/`, the site to `sites-available/h6ai.conf`
  (Debian, Ubuntu), `conf.d/h6ai.conf` (RHEL, Fedora) or `http.d/h6ai.conf` (Alpine). If the
  distribution's welcome site also claims the port, it's disabled; `--uninstall` restores it.
* Opens the port in firewalld or ufw if one of them is active.
* SELinux (RHEL, Fedora): labels the shared folder for nginx and the writable folders for PHP,
  allows the port, and turns PHP's JIT off (it needs executable memory).
* Adds the `h6ai-user` command and records the setup in `/etc/h6ai/install.conf`.

`/etc/nginx/h6ai/trusted-html.map` (HTML that may run script, see SECURITY.md) is yours: upgrades
never overwrite it.

### Upgrade

Unpack the new release and run its `install.sh`. It reuses the settings recorded in
`/etc/h6ai/install.conf`, replaces the code and configuration, and restarts PHP-FPM and nginx.
Users, permissions and settings are kept.

### Uninstall

```sh
sudo ./install.sh --uninstall           # keeps <root>/_h6ai, so a re-install picks up the users again
sudo ./install.sh --uninstall --purge   # deletes h6ai's data too
```

Neither removes nginx, PHP or your files.

### HTTPS

The generated site is a plain nginx server block, so certbot can add TLS to it:

```sh
sudo ./install.sh --server-name files.example.com
sudo certbot --nginx -d files.example.com
```

Upgrades keep a site file that was edited since the installer wrote it (by certbot or by hand) and
put the installer's version next to it as `h6ai.conf.h6ai-new`. The h6ai parts it includes from
`/etc/nginx/h6ai/` are always updated.

If TLS ends at a separate reverse proxy or load balancer instead, set the public address and the
proxy's address under **Admin → System → Public address and reverse proxy**.

### Next to other sites

With `--server-name`, h6ai only answers for that name and other sites on the same port keep
working. `--listen` binds it to one address. To add h6ai to an existing server block instead,
include the snippets from `/etc/nginx/h6ai/` yourself ([DEPLOYMENT.md](DEPLOYMENT.md)).

### Logs

* nginx: `/var/log/nginx/h6ai.access.log`, `/var/log/nginx/h6ai.error.log`
* PHP: the PHP-FPM log (`/var/log/php8.3-fpm.log` on Debian and Ubuntu, `journalctl -u php-fpm`
  elsewhere)
* Downloads and logins: the admin page's Activity tab

A `502` or `500` page usually means PHP-FPM isn't running (`systemctl status php8.3-fpm`). A
`403` for the whole site usually means nginx or the `h6ai` user can't read the shared folder:
both need read and execute permission on it and its parents.

## Docker

Needs Docker with the Compose plugin (`docker compose version`). Two ways:

**With the installer**, from a release bundle. No Node or git checkout needed: the image is built
from the bundle's prebuilt files.

```sh
sudo ./install.sh --docker --root /srv/files --port 8080
```

It puts the Dockerfile, `compose.yaml` and a generated `.env` into `/opt/h6ai` (compose project
`h6ai`), builds the image, starts the container, waits until it's healthy and prints the URLs and
the admin password. Re-run it from a newer release to upgrade. `--uninstall` removes the container
and keeps the `h6ai-data` volume; `--uninstall --purge` also deletes the volume, the image and
`/opt/h6ai`. `h6ai-user` on the host runs inside the container.

**With compose directly**, from a git checkout:

```sh
git clone <your h6ai repository> h6ai && cd h6ai
cp .env.example .env              # set the folder to share, address and port
docker compose up -d --build
docker compose logs h6ai          # shows the generated admin password once
```

Open `http://<host>:8080/` for the files and `http://<host>:8080/_h6ai/public/` for the admin
page. Sign in as `admin` with the password from the log, then change it in the account menu.

### Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `H6AI_FILES` | `./files` | folder to share |
| `H6AI_BIND` | `0.0.0.0` | address to publish on, e.g. `192.168.1.10` for one interface |
| `H6AI_PORT` | `8080` | port to publish |
| `H6AI_ADMIN_USER` | `admin` | name of the first admin, created on the first start |
| `H6AI_ADMIN_PASSWORD` | *(empty)* | its password; empty generates one and prints it to the log |
| `PHP_MEMORY_LIMIT` | `256M` | |

For Docker secrets, set `H6AI_ADMIN_PASSWORD_FILE` in `compose.yaml` instead of the password. The
first admin is only created while no admin exists, so changing these later has no effect.
Use `h6ai-user` (below) to add admins or reset a password.

Option overrides (`options.local.json`, see the README) go into
`<shared folder>/_h6ai/private/conf/options.local.json`. They survive upgrades.

### Upgrade

```sh
git pull
docker compose up -d --build
```

The container copies the new code into `_h6ai` on start. Users, permissions, settings and the
activity log live in the `h6ai-data` volume and are kept.

### Backup

Everything h6ai stores is in the `h6ai-data` volume (`<project>_h6ai-data`, see
`docker volume ls`):

```sh
docker run --rm -v h6ai_h6ai-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/h6ai-data.tgz -C /data .
```

### HTTPS

Put a TLS-terminating reverse proxy in front of the container, then set the **public address**
(e.g. `https://files.example.com`) and the proxy's address under **Admin → System → Public address
and reverse proxy**. The card shows the address your requests arrive from. With Caddy:

```
files.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Publish the container on the loopback interface only (`H6AI_BIND=127.0.0.1`) when a proxy on the
same host serves it.

### Development and tests

`compose.dev.yaml` turns the container into the test environment: a sample tree (including a
7 GiB file) in `./webroot`, the bootstrap login `admin` / `admin-test`, the options the tests
expect, and port 8687. The integration and browser tests run against it. See
[`docker/README.md`](../docker/README.md).

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

## Managing users from the shell

`h6ai-user` creates the first admin, resets a lost password and lists accounts. It's part of both
install types.

```sh
h6ai-user list
h6ai-user add NAME --admin          # asks for the password
h6ai-user add NAME --anon           # a download-only account
h6ai-user passwd NAME               # new password, signs the user out everywhere
h6ai-user disable NAME | enable NAME
```

`--password-stdin` reads the password from standard input, `--generate` creates one and prints it.
After `install.sh --docker`, `h6ai-user` on the host runs inside the container. With compose
directly, prefix the commands with `docker compose exec h6ai`. Everything else (roles, folder
groups, permissions) is on the admin page.

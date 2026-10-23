# Native install (bare metal or VM)

h6ai runs directly on the server's operating system: the distribution's nginx and PHP-FPM, set up
by `install.sh`. No Docker involved. Other ways to install: [Docker](docker.md),
[drop-in](dropin.md), or the [overview](../INSTALL.md).

```
browser ──▶ nginx ──auth_request──▶ PHP-FPM (pool "h6ai", user h6ai) ── h6ai
              │                        "may this visitor have this file?"
              └── sendfile ──▶ the file, straight from disk (Range, resume, ETag)
```

nginx serves every file itself, but asks h6ai first. Folder permissions therefore also cover
direct links, and downloads run at full disk and network speed.

## Contents

1. [Requirements](#1-requirements)
2. [Get the release bundle](#2-get-the-release-bundle)
3. [Install](#3-install)
4. [First login](#4-first-login)
5. [Where everything is](#5-where-everything-is)
6. [Installer options](#6-installer-options)
7. [Notes per distribution](#7-notes-per-distribution)
8. [HTTPS, reverse proxies, other sites](#8-https-reverse-proxies-other-sites)
9. [Upgrade, backup, uninstall](#9-upgrade-backup-uninstall)
10. [Troubleshooting](#10-troubleshooting)

## 1. Requirements

* A supported system, with root access (`sudo`):

  | System | PHP the installer uses | CVE-2026-109618 |
  |---|---|---|
  | Debian 12 | 8.2.35 | fixed |
  | Debian 13 | 8.4.27 | fixed |
  | Ubuntu 22.04 | 8.1 is too old: ppa:ondrej/php gives 8.4.27 (asks first) | fixed |
  | Ubuntu 24.04 | 8.3.6 | fixed (Ubuntu backport) |
  | Ubuntu 26.04 | 8.5.4 | fixed (Ubuntu backport) |
  | Rocky, Alma, RHEL 9 | 8.3.36 (module stream php:8.3) | fixed |
  | Fedora 44 | 8.5.12 | fixed |
  | Alpine 3.22 | 8.4.27 | fixed |

  Every system in this table is tested by `test-native/run.sh`: a clean container stands in for
  a fresh install, the installer runs in it, then the full integration suite runs against the
  result. `test-native/systemd.sh` repeats it under a real systemd, including a reboot.
* Internet access for the package manager.
* A free port (80 by default). If nginx already serves other sites, see
  [section 8](#8-https-reverse-proxies-other-sites).
* Disk: about 100 MB for nginx, PHP and h6ai, plus about 400 MB for ffmpeg and ImageMagick
  (video and PDF thumbnails; `--no-thumbnail-tools` skips them).

## 2. Get the release bundle

The bundle `h6ai-<version>.tar.gz` (or `.zip`) contains the built application, the installer and
the configuration it writes. Copy it to the server and unpack it:

```sh
tar xzf h6ai-1.0.0.tar.gz
cd h6ai-1.0.0
```

To make a bundle yourself from a git checkout (needs Node.js 20 or later):

```sh
npm ci
npm run release        # build/h6ai-1.0.0.tar.gz, .zip, and the drop-in zips
```

Running `install.sh` straight from a checkout also works after `npm ci && npm run build`.

## 3. Install

```sh
sudo ./install.sh --native
```

Without `--native` the installer first asks whether to install natively or with Docker. Then:

```
==> Installing h6ai 1.0.0 natively on Ubuntu 24.04.5 LTS
Folder to share [/srv/h6ai]: /srv/files
HTTP port [80]:
    shared folder: /srv/files
    listen:        *:80  server_name _
Continue? (y/n) [y]:
==> Installing packages (apt)
    nginx, PHP 8.3
    PHP 8.3.6: CVE-2026-109618 fixed (distribution backport)
==> Setting up the h6ai system user and folders
==> Installing h6ai 1.0.0 into /srv/files/_h6ai
==> Configuring PHP-FPM (pool h6ai, /run/php/h6ai.sock)
==> Configuring nginx (/etc/nginx/sites-available/h6ai.conf)
==> Creating the admin user "admin"
    choose a password (at least 8 characters), or press Enter twice to generate one
Password:
Repeat password:
==> Starting PHP-FPM and nginx
    check: index 200, private files 403

h6ai 1.0.0 is ready.
  Files:    http://files.example.com/          (shared folder /srv/files)
  Admin:    http://files.example.com/_h6ai/public/
  Users:    h6ai-user list | add NAME [--admin] | passwd NAME
  Config:   /etc/nginx/sites-available/h6ai.conf, /etc/php/8.3/fpm/pool.d/h6ai.conf
  Upgrade:  run install.sh from a newer release. Remove: install.sh --uninstall
```

Your files go into the shared folder (`/srv/files` above). Anything you copy there shows up
immediately. h6ai only adds its own `_h6ai` folder there, which listings hide.

**Unattended** (no questions; a generated admin password is printed at the end):

```sh
sudo ./install.sh --native --yes --root /srv/files --port 8080
sudo ./install.sh --native --yes --root /srv/files --admin-password-file /root/h6ai-pass
```

### What the installer changes

* **Packages:** `nginx`, `php-fpm` with `gd`, `mbstring`, `opcache`, `exif` and `posix`, `zip`,
  and ffmpeg, ImageMagick and Ghostscript, whichever the system offers.
* **User:** the system user `h6ai`. PHP-FPM runs h6ai as that user in its own pool, so other PHP
  sites on the host keep their settings. Sessions are kept in `/var/lib/h6ai/sessions`.
* **Application:** installed into `<shared folder>/_h6ai`. PHP may only write
  `public/cache`, `private/cache` and `private/data`; the code is root owned.
* **PHP:** the pool file (e.g. `/etc/php/8.3/fpm/pool.d/h6ai.conf`) carries the settings from
  `deploy/php/h6ai.ini`: no uploads, PHP doesn't parse request bodies, streaming, hardened
  sessions. OPcache, JIT and the realpath cache are process wide; they go into
  `conf.d/90-h6ai.ini`.
* **nginx:** the h6ai parts go to `/etc/nginx/h6ai/`, and the site goes to
  `sites-available/h6ai.conf` (Debian, Ubuntu), `conf.d/h6ai.conf` (RHEL, Fedora) or
  `http.d/h6ai.conf` (Alpine). If the distribution's welcome page also claims the port, it's
  disabled, and `--uninstall` restores it.
* **Firewall:** firewalld or ufw, when active, get the port opened.
* **SELinux** (RHEL, Fedora): the shared folder is labelled for nginx, the writable folders for
  PHP, and the port allowed. PHP's JIT is turned off, because it needs executable memory, which
  SELinux denies.
* **Services:** PHP-FPM and nginx are enabled at boot (systemd or OpenRC).
* **Shell tools:** the `h6ai-user` command, and `/etc/h6ai/install.conf`, which records the setup
  for upgrades.

## 4. First login

1. Open `http://<server>/_h6ai/public/` and log in as `admin` with the password you chose (or the
   generated one from the summary).
2. **Access → Users**: change the password in the account menu, or add your own admin account.
3. Set permissions as needed, see the README's
   [Access control](../../README.md#access-control).
4. **System** tab: every check should be green.

Forgot the password? On the server:

```sh
sudo h6ai-user passwd admin
```

## 5. Where everything is

| What | Where |
|---|---|
| Your files | the shared folder, e.g. `/srv/files` |
| h6ai | `<shared folder>/_h6ai` (code root owned, read only for PHP) |
| Users, permissions, settings, activity log | `<shared folder>/_h6ai/private/data/` |
| Option overrides | `<shared folder>/_h6ai/private/conf/options.local.json` (yours, kept on upgrades) |
| nginx site | `sites-available/h6ai.conf`, `conf.d/h6ai.conf` or `http.d/h6ai.conf` under `/etc/nginx` |
| nginx h6ai parts | `/etc/nginx/h6ai/` (`trusted-html.map` is yours, kept on upgrades) |
| PHP-FPM pool, PHP settings | e.g. `/etc/php/8.3/fpm/pool.d/h6ai.conf`, `/etc/php/8.3/fpm/conf.d/90-h6ai.ini` |
| PHP sessions | `/var/lib/h6ai/sessions` |
| Install record | `/etc/h6ai/install.conf` |
| Logs | `/var/log/nginx/h6ai.access.log`, `/var/log/nginx/h6ai.error.log`, the PHP-FPM log |

## 6. Installer options

| Option | |
|---|---|
| `--native`, `--docker` | how h6ai runs (asked if neither is given) |
| `--root DIR` | folder to share (default `/srv/h6ai`) |
| `--port N` | HTTP port (default 80) |
| `--listen ADDR` | listen on one address only, e.g. `192.168.1.10` (default: all) |
| `--server-name NAMES` | nginx `server_name`, e.g. `files.example.com`. Without it, h6ai is the default site for its port. |
| `--admin NAME` | name of the first admin (default `admin`) |
| `--admin-password-file F` | read the first admin's password from a file |
| `--no-admin` | don't create an admin; do it later with `h6ai-user add NAME --admin` |
| `--no-thumbnail-tools` | skip ffmpeg, ImageMagick and Ghostscript |
| `--no-firewall` | don't open the port in firewalld or ufw |
| `--allow-php-repo` | if the distribution's PHP is older than 8.2, add Ondřej Surý's PHP repository without asking |
| `--allow-unpatched-php` | install even if PHP lacks the CVE-2026-109618 fix |
| `-y`, `--yes` | don't ask, use the defaults |
| `--uninstall` | remove h6ai from nginx and PHP-FPM; keep `<root>/_h6ai` |
| `--uninstall --purge` | also delete `<root>/_h6ai` (users, settings), `/var/lib/h6ai` and the `h6ai` user |

## 7. Notes per distribution

* **Ubuntu 22.04, Debian 11:** their PHP is older than 8.2. The installer offers Ondřej Surý's
  repository (`ppa:ondrej/php` on Ubuntu, `packages.sury.org` on Debian); `--allow-php-repo`
  accepts it in advance.
* **Debian, Ubuntu:** `apt` upgrades keep PHP patched. Ubuntu backports security fixes without
  changing the PHP version, so h6ai reads the package changelog to tell a fixed 8.3.6 from an old
  one. Both the installer and the admin page do this.
* **Rocky, Alma, RHEL 9:** the default PHP is 8.0; the installer enables the newest module stream
  (`php:8.3`). ffmpeg and ImageMagick need EPEL and RPM Fusion; without them h6ai shows icons
  for videos instead of thumbnails. PDF thumbnails work with the base system's Ghostscript.
* **Alpine:** OpenRC services. The newest `phpNN` packages are used (8.4 on 3.22).
* **SELinux:** see [section 3](#what-the-installer-changes). If you move the shared folder later,
  run the installer again so it labels the new one.

## 8. HTTPS, reverse proxies, other sites

**HTTPS with Let's Encrypt.** The generated site is a plain nginx server block, so certbot can
add TLS to it:

```sh
sudo ./install.sh --native --server-name files.example.com
sudo certbot --nginx -d files.example.com
```

Upgrades keep a site file that was edited since the installer wrote it (by certbot or by hand).
They put the installer's version next to it as `h6ai.conf.h6ai-new`. The h6ai parts it includes
from `/etc/nginx/h6ai/` are always updated.

**Behind a reverse proxy or load balancer** (TLS ends there): in the admin page, **System →
Public address and reverse proxy**, enter the address visitors use and the proxy's IP. The card
shows the address your own requests arrive from.

**Next to other sites:**
* `--server-name files.example.com` makes h6ai answer only for that name; other sites on the same
  port keep working.
* `--listen` binds it to one address.
* To add h6ai to an existing server block instead, include the snippets yourself
  ([DEPLOYMENT.md](../DEPLOYMENT.md)).

## 9. Upgrade, backup, uninstall

**Upgrade:** unpack the new release and run its installer.

```sh
tar xzf h6ai-1.1.0.tar.gz && cd h6ai-1.1.0
sudo ./install.sh
```

It reuses the settings from `/etc/h6ai/install.conf`, replaces the code and configuration, and
restarts PHP-FPM and nginx. Users, permissions, settings and the activity log are kept.

**Backup:** `<shared folder>/_h6ai/private/data/` holds everything h6ai stores, and
`_h6ai/private/conf/options.local.json` holds your option overrides. Your files are your own
backup's business. For example:

```sh
sudo tar czf h6ai-data-$(date +%F).tgz -C /srv/files/_h6ai/private data conf/options.local.json
```

**Restore:** install the same or a newer version, stop PHP-FPM, unpack the archive back into
`_h6ai/private/`, then `sudo chown -R h6ai: /srv/files/_h6ai/private/data` and start PHP-FPM again.

**Uninstall:**

```sh
sudo ./install.sh --uninstall           # keeps _h6ai, so a re-install finds the users again
sudo ./install.sh --uninstall --purge   # also deletes h6ai's data and the h6ai user
```

Neither removes nginx, PHP or your files.

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The installer stops: "PHP … is too old" | Ubuntu 22.04 / Debian 11: allow the PHP repository (`--allow-php-repo`) |
| The installer stops: "affected by CVE-2026-109618" | update PHP (`apt upgrade` / `dnf upgrade`), then run the installer again |
| "nginx rejects the configuration" | another site uses the port as default server: use `--port`, `--listen` or `--server-name`; `nginx -t` shows the conflict |
| `502 Bad Gateway` | PHP-FPM isn't running: `systemctl status php8.3-fpm` (or `php-fpm`, `php-fpm84`) |
| `403` for the whole site | nginx or the `h6ai` user can't read the shared folder: both need read and execute permission on it and on every parent folder (`chmod o+rx`) |
| Thumbnails missing for videos or PDFs | ffmpeg or Ghostscript isn't installed; the System tab shows which tool is missing |
| Login says "cross-origin request rejected" | behind a proxy that rewrites the host: set the public address in **System → Public address and reverse proxy** |
| Too many failed logins, locked out | wait 15 minutes, or `sudo rm /srv/files/_h6ai/private/cache/ratelimit-*` |
| Lost the admin password | `sudo h6ai-user passwd admin` |

Logs: `/var/log/nginx/h6ai.error.log`, the PHP-FPM log (`/var/log/php8.3-fpm.log` on Debian and
Ubuntu, `journalctl -u php-fpm` elsewhere), and the admin page's Activity tab for downloads and
logins.

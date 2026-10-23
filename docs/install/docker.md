# Docker install

h6ai runs in one container that brings its own nginx and PHP-FPM 8.3 (patched, version-gated at
build time), OPcache and JIT. The host only needs Docker. Other ways to install:
[native](native.md), [drop-in](dropin.md), or the [overview](../INSTALL.md).

```
browser ──▶ host port ──▶ container: nginx ──auth_request──▶ PHP-FPM ── h6ai
                                        └── sendfile ──▶ your folder (bind mount)
                          volume h6ai-data: users, permissions, settings, activity log
```

## Contents

1. [Requirements](#1-requirements)
2. [Install with the installer](#2-install-with-the-installer)
3. [Install with compose from a git checkout](#3-install-with-compose-from-a-git-checkout)
4. [First login](#4-first-login)
5. [Settings](#5-settings)
6. [Where everything is](#6-where-everything-is)
7. [Day to day](#7-day-to-day)
8. [HTTPS and reverse proxies](#8-https-and-reverse-proxies)
9. [Upgrade, backup, uninstall](#9-upgrade-backup-uninstall)
10. [Troubleshooting](#10-troubleshooting)

## 1. Requirements

* Docker Engine with the Compose plugin: `docker compose version` must work. On Debian and
  Ubuntu, follow <https://docs.docker.com/engine/install/>.
* A free port on the host (80 or 8080, your choice).
* The folder you want to share, readable by the container (it runs nginx as `nginx` and PHP as
  `www-data`, uid 82). World-readable files (`chmod -R o+rX`) always work.
* About 600 MB for the image (the PHP base image with ffmpeg and ImageMagick for thumbnails).

There are two ways to set it up: with the installer from a release bundle (no git, no Node.js),
or with `docker compose` from a git checkout.

## 2. Install with the installer

```sh
tar xzf h6ai-1.0.0.tar.gz && cd h6ai-1.0.0
sudo ./install.sh --docker --root /srv/files --port 8080
```

```
==> Installing h6ai 1.0.0 with Docker
    shared folder: /srv/files
    listen:        *:8080
Continue? (y/n) [y]:
    password for the admin "admin" (at least 8 characters), or Enter to generate one
    Password:
==> Preparing /opt/h6ai
==> Building the image and starting the container (the first build takes a few minutes)
    container healthy

h6ai 1.0.0 is ready.
  Files:    http://files.example.com:8080/          (shared folder /srv/files)
  Admin:    http://files.example.com:8080/_h6ai/public/
  Users:    h6ai-user list | add NAME [--admin] | passwd NAME
  Docker:   /opt/h6ai (cd there for docker compose logs, restart, ...)
```

What it does:
* Puts the Dockerfile, `compose.yaml` and a generated `.env` into `/opt/h6ai`, under compose
  project `h6ai`.
* Builds the image from the bundle's prebuilt files, starts the container and waits until it's
  healthy.
* Installs `h6ai-user` on the host, which runs inside the container.

Options: `--root`, `--port`, `--listen ADDR` (publish on one address), `--admin NAME`,
`--admin-password-file F`, `--yes`. See `./install.sh --help`.

## 3. Install with compose from a git checkout

```sh
git clone https://github.com/paulmataruso/h6ai.git && cd h6ai
cp .env.example .env
```

Edit `.env`:

```sh
H6AI_FILES=/srv/files        # the folder to share
H6AI_BIND=0.0.0.0            # or one address, e.g. 192.168.1.10
H6AI_PORT=8080
H6AI_ADMIN_USER=admin
H6AI_ADMIN_PASSWORD=         # empty: generated and printed to the log once
```

Then:

```sh
docker compose up -d --build
docker compose logs h6ai | grep -A2 "first admin"
```

```
h6ai-1  | [init] Created the first admin user "admin" with the password:
h6ai-1  | [init]     u4d2GY5RA6ckNoxPamoQ
h6ai-1  | [init] Sign in at /_h6ai/public/ and change it in the account menu.
```

## 4. First login

1. Open `http://<host>:<port>/_h6ai/public/` and log in as `admin` with the password from the
   installer summary or the log.
2. Change the password in the account menu, or add your own admin under **Access → Users**.
3. **System** tab: every check should be green.

The first admin is only created while no admin exists. Changing `H6AI_ADMIN_PASSWORD` later has
no effect: use `h6ai-user` (below).

## 5. Settings

`.env` (in `/opt/h6ai` after the installer, or next to `compose.yaml`):

| Variable | Default | |
|---|---|---|
| `H6AI_FILES` | `./files` | folder to share (bind mount to `/srv/www`) |
| `H6AI_BIND` | `0.0.0.0` | address to publish on |
| `H6AI_PORT` | `8080` | port to publish |
| `H6AI_ADMIN_USER` | `admin` | first admin, created on the first start |
| `H6AI_ADMIN_PASSWORD` | *(empty)* | its password; empty generates one |
| `PHP_MEMORY_LIMIT` | `256M` | |

For Docker secrets, set `H6AI_ADMIN_PASSWORD_FILE` in `compose.yaml` instead of the password.

Option overrides go into `<shared folder>/_h6ai/private/conf/options.local.json`. Everything else
(users, permissions, theme, Google, the public address behind a proxy) is on the admin page.

## 6. Where everything is

| What | Where |
|---|---|
| Your files | the host folder `H6AI_FILES`, at `/srv/www` in the container |
| h6ai | copied into `<shared folder>/_h6ai` on every start (code only) |
| Users, permissions, settings, activity log | volume `<project>_h6ai-data` (`h6ai_h6ai-data` with the installer) |
| nginx config | `/etc/nginx/http.d/h6ai.conf` and `/etc/nginx/h6ai/` in the image |
| PHP settings | `/usr/local/etc/php/conf.d/zz-h6ai.ini` in the image |
| Logs | `docker compose logs h6ai` |

## 7. Day to day

```sh
cd /opt/h6ai                                  # or your checkout
docker compose logs -f h6ai                   # nginx and PHP-FPM logs
docker compose restart h6ai
docker compose exec h6ai h6ai-user list       # or plain `h6ai-user list` after install.sh --docker
docker compose exec h6ai h6ai-user passwd admin
docker compose exec h6ai sh                   # a shell in the container
```

Add files by copying them into the shared folder on the host; they show up immediately.

## 8. HTTPS and reverse proxies

Put a TLS-terminating reverse proxy in front of the container:
1. Publish the container on the loopback interface only (`H6AI_BIND=127.0.0.1`).
2. Point the proxy at it.
3. In the admin page, **System → Public address and reverse proxy**, enter the public address
   and the proxy's IP. The card shows the address your own requests arrive from.

Caddy (automatic Let's Encrypt):

```
files.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name files.example.com;
    # ssl_certificate ...;
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;              # stream big downloads instead of spooling them
        proxy_read_timeout 3600s;
    }
}
```

## 9. Upgrade, backup, uninstall

**Upgrade.** With the installer, unpack the new release and run `sudo ./install.sh` (it remembers
the Docker setup). With compose:

```sh
git pull
docker compose up -d --build
```

Users and settings stay in the volume; the container copies the new code into `_h6ai` on start.

**Backup** of the data volume:

```sh
docker run --rm -v h6ai_h6ai-data:/data:ro -v "$PWD":/backup alpine \
    tar czf /backup/h6ai-data-$(date +%F).tgz -C /data .
```

**Restore:**

```sh
docker compose stop h6ai
docker run --rm -v h6ai_h6ai-data:/data -v "$PWD":/backup alpine \
    sh -c 'tar xzf /backup/h6ai-data-2026-10-23.tgz -C /data && chown -R 82:82 /data'
docker compose start h6ai
```

**Uninstall:**

```sh
sudo ./install.sh --uninstall           # removes the container, keeps the data volume
sudo ./install.sh --uninstall --purge   # also the volume, the image and /opt/h6ai
docker compose down                     # with compose; add -v to delete the data volume too
```

Your files are never touched. `<shared folder>/_h6ai` can be deleted by hand afterwards.

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `port is already allocated` | another service uses the port: change `H6AI_PORT` (or `--port`) |
| Empty listing, or `403` | the container can't read the folder: `chmod -R o+rX /srv/files` |
| No admin password in the log | an admin exists already (data volume from an earlier install); use `h6ai-user passwd admin` |
| Container not healthy | `docker compose logs h6ai` shows the failing step (nginx or PHP-FPM config test) |
| Login says "cross-origin request rejected" behind a proxy | set the public address and the proxy IP in **System → Public address and reverse proxy** |
| Big downloads stall behind your own proxy | turn off proxy buffering and raise its read timeout (see the nginx example above) |
| Locked out after failed logins | wait 15 minutes, or `docker compose exec h6ai sh -c 'rm -f /srv/www/_h6ai/private/cache/ratelimit-*'` |

The development environment (sample files, the bootstrap login `admin` / `admin-test`, port 8687)
is `compose.dev.yaml`, see [docker/README.md](../../docker/README.md).

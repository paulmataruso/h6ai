#!/bin/sh
# h6ai installer. You pick how h6ai runs:
#   native  directly on this system (bare metal or VM): nginx + PHP-FPM from the distribution's
#           packages on Debian, Ubuntu, Fedora, RHEL/Rocky/Alma and Alpine
#   docker  in a container with its own nginx + PHP-FPM, on any Linux with Docker
#
#   sudo ./install.sh                          asks native or Docker, or upgrades an existing install
#   sudo ./install.sh --native --root /srv/files --port 8080
#   sudo ./install.sh --docker --root /srv/files --port 8080
#   sudo ./install.sh --uninstall [--purge]
#
# Run it from a release bundle (h6ai-<version>/) or from a git checkout after `npm run build`.
# Re-running it upgrades h6ai and keeps users, permissions and settings. See docs/INSTALL.md.
set -eu

STATE=/etc/h6ai/install.conf
LIB=/var/lib/h6ai
DOCKER_DIR=/opt/h6ai
HERE=$(cd "$(dirname "$0")" && pwd)

usage() {
    cat <<'EOF'
Usage: sudo ./install.sh [options]

Installs h6ai, natively (nginx and PHP-FPM on this system) or with Docker. Run it again
to upgrade: the settings of the previous run are reused, users, permissions and settings
are kept.

  --native               run h6ai directly on this system (asked if neither is given)
  --docker               run h6ai in a Docker container (/opt/h6ai, compose project "h6ai")
  --root DIR             folder to share (default /srv/h6ai)
  --port N               HTTP port (default 80)
  --listen ADDR          listen on this address only, e.g. 192.168.1.10 (default: all)
  --admin NAME           name of the first admin user (default admin)
  --admin-password-file F  read the first admin's password from file F
                         (default: ask, or generate one with --yes)
  --no-admin             native: don't create an admin; do it later with `h6ai-user add NAME --admin`
  -y, --yes              don't ask questions, use the defaults
  --uninstall            native: remove the nginx site, the PHP-FPM pool and h6ai-user, keep
                         <root>/_h6ai (users, settings). Docker: remove the container, keep
                         the h6ai-data volume
  --purge                with --uninstall: also delete h6ai's data (<root>/_h6ai, /var/lib/h6ai
                         and the h6ai user; Docker: the volume, /opt/h6ai and the image).
                         Your own files are never deleted.

Native only:
  --server-name NAMES    nginx server_name, e.g. files.example.com (default: any host)
  --no-site              don't write an nginx server block: install h6ai, PHP-FPM and nginx's
                         http-level part, and include h6ai/server.conf in a server block of
                         your own (docs/DEPLOYMENT.md). Upgrades keep this choice.
  --no-thumbnail-tools   skip ffmpeg, ImageMagick and Ghostscript (video and PDF thumbnails)
  --no-firewall          don't open the port in firewalld or ufw
  --allow-php-repo       if the distribution's PHP is older than 8.2, add the PHP repository
                         of Ondřej Surý (Debian, Ubuntu) without asking
  --allow-unpatched-php  install even if PHP lacks the fix for CVE-2026-109618
  -h, --help             show this help
EOF
}

# --- output -------------------------------------------------------------------------------------
if [ -t 1 ]; then
    BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m'); YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
else
    BOLD=; DIM=; RED=; YELLOW=; RESET=
fi
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s warning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() { printf '%s error:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
# single-quote a value for the state file (sourced by sh)
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# --- options ------------------------------------------------------------------------------------
# previous run first, so a plain re-run (upgrade) keeps the same setup
H6AI_ROOT=/srv/h6ai
H6AI_PORT=80
H6AI_LISTEN=
H6AI_SERVER_NAME=_
H6AI_VERSION=
H6AI_MODE=
H6AI_NO_SITE=0
DISABLED_SITE=
if [ -r "$STATE" ]; then
    # shellcheck disable=SC1090
    . "$STATE"
fi
PREVIOUS_VERSION=$H6AI_VERSION
PREVIOUS_NO_SITE=$H6AI_NO_SITE
# an install from before the Docker option is native
[ -z "$PREVIOUS_VERSION" ] || : "${H6AI_MODE:=native}"
MODE=
ADMIN_NAME='admin'
ADMIN_PASSWORD_FILE=
NO_ADMIN=0
TOOLS=1
FIREWALL=1
ALLOW_PHP_REPO=0
ALLOW_UNPATCHED=0
YES=0
UNINSTALL=0
PURGE=0
SITE_ARGS=

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
    case $1 in
        --native) MODE=native ;;
        --docker) MODE=docker ;;
        --root) need_arg "$@"; H6AI_ROOT=$2; shift ;;
        --port) need_arg "$@"; H6AI_PORT=$2; SITE_ARGS="$SITE_ARGS $1"; shift ;;
        --listen) need_arg "$@"; H6AI_LISTEN=$2; SITE_ARGS="$SITE_ARGS $1"; shift ;;
        --server-name) need_arg "$@"; H6AI_SERVER_NAME=$2; SITE_ARGS="$SITE_ARGS $1"; shift ;;
        --no-site) H6AI_NO_SITE=1 ;;
        --admin) need_arg "$@"; ADMIN_NAME=$2; shift ;;
        --admin-password-file) need_arg "$@"; ADMIN_PASSWORD_FILE=$2; shift ;;
        --no-admin) NO_ADMIN=1 ;;
        --no-thumbnail-tools) TOOLS=0 ;;
        --no-firewall) FIREWALL=0 ;;
        --allow-php-repo) ALLOW_PHP_REPO=1 ;;
        --allow-unpatched-php) ALLOW_UNPATCHED=1 ;;
        -y|--yes) YES=1 ;;
        --uninstall) UNINSTALL=1 ;;
        --purge) PURGE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
done

INTERACTIVE=0
[ "$YES" = 0 ] && [ -t 0 ] && INTERACTIVE=1

# ask "question" default -> answer on stdout
ask() {
    if [ "$INTERACTIVE" = 1 ]; then
        printf '%s [%s]: ' "$1" "$2" >&2
        read -r answer || answer=
        printf '%s' "${answer:-$2}"
    else
        printf '%s' "$2"
    fi
}
confirm() {
    [ "$INTERACTIVE" = 1 ] || return 0
    case $(ask "$1 (y/n)" y) in [Yy]*) return 0 ;; *) return 1 ;; esac
}

[ "$(id -u)" = 0 ] || die "run the installer as root, e.g. sudo $0"
[ "$PURGE" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--purge only works together with --uninstall"
[ "$H6AI_NO_SITE" = 0 ] || [ -z "$SITE_ARGS" ] || [ "$UNINSTALL" = 1 ] \
    || die "--no-site leaves the server block to you:${SITE_ARGS} doesn't apply. Set listen and server_name in your server block."
case $H6AI_PORT in ''|*[!0-9]*) die "--port must be a number" ;; esac
case $H6AI_ROOT in /*) ;; *) die "--root must be an absolute path" ;; esac
H6AI_ROOT=${H6AI_ROOT%/}
[ -n "$H6AI_ROOT" ] && [ "$H6AI_ROOT" != / ] || die "--root can't be /"
case $ADMIN_NAME in [A-Za-z0-9]*) ;; *) die "invalid --admin name" ;; esac

# --- native or Docker ------------------------------------------------------------------------------
have_docker() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }
if [ -n "$H6AI_MODE" ]; then
    [ -z "$MODE" ] || [ "$MODE" = "$H6AI_MODE" ] || [ "$UNINSTALL" = 1 ] \
        || die "h6ai is installed with --$H6AI_MODE here. Run --uninstall first to switch."
    MODE=$H6AI_MODE
elif [ "$UNINSTALL" = 1 ]; then
    die "no h6ai install found ($STATE missing)"
elif [ -z "$MODE" ]; then
    MODE=native
    if [ "$INTERACTIVE" = 1 ]; then
        docker_note=
        have_docker || docker_note=" (Docker isn't installed)"
        printf '%sHow should h6ai run?%s\n' "$BOLD" "$RESET" >&2
        printf '  1) natively on this system: nginx and PHP-FPM from the distribution'"'"'s packages\n' >&2
        printf '  2) in Docker: one container with its own nginx and PHP-FPM%s\n' "$docker_note" >&2
        case $(ask "Choose 1 or 2" 1) in
            1|native) MODE=native ;;
            2|docker) MODE=docker ;;
            *) die "please answer 1 or 2" ;;
        esac
    fi
fi

# --- distribution -------------------------------------------------------------------------------
[ -r /etc/os-release ] || die "can't identify the Linux distribution (/etc/os-release missing)"
# shellcheck disable=SC1091
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*) FAMILY=debian ;;
    *" rhel "*|*" fedora "*|*" centos "*) FAMILY=rhel ;;
    *" alpine "*) FAMILY=alpine ;;
    *) FAMILY=
       [ "$MODE" = docker ] || die "${PRETTY_NAME:-this distribution} isn't supported by the native installer. Use --docker, or see docs/DEPLOYMENT.md for a manual setup." ;;
esac

HAS_SYSTEMD=0; HAS_OPENRC=0
[ -d /run/systemd/system ] && HAS_SYSTEMD=1
[ "$FAMILY" = alpine ] && command -v rc-service >/dev/null 2>&1 && [ -e /run/openrc/softlevel ] && HAS_OPENRC=1

service_do() { # action service
    if [ "$HAS_SYSTEMD" = 1 ]; then
        case $1 in
            enable) systemctl enable --now "$2" ;;
            reload) systemctl reload-or-restart "$2" ;;
            *) systemctl "$1" "$2" ;;
        esac
    elif [ "$HAS_OPENRC" = 1 ]; then
        case $1 in
            enable) rc-update add "$2" default >/dev/null; rc-service "$2" start ;;
            reload) rc-service "$2" reload 2>/dev/null || rc-service "$2" restart ;;
            disable) rc-service "$2" stop || true; rc-update del "$2" default >/dev/null || true ;;
            *) rc-service "$2" "$1" ;;
        esac
    elif [ -x "/etc/init.d/$2" ]; then
        case $1 in
            enable) "/etc/init.d/$2" start ;;
            reload) "/etc/init.d/$2" reload ;;
            # the scripts' own restart can race the old master's exit
            restart) "/etc/init.d/$2" stop || true; sleep 1; "/etc/init.d/$2" start ;;
            disable) ;;
            *) "/etc/init.d/$2" "$1" ;;
        esac
    else
        return 1
    fi
}

# =================================================================================================
# uninstall
# =================================================================================================
if [ "$UNINSTALL" = 1 ] && [ "$MODE" = docker ]; then
    step "Removing the h6ai container"
    if [ "$PURGE" = 1 ]; then
        (cd "$H6AI_DOCKER_DIR" && docker compose down -v --rmi all) || warn "docker compose down failed"
        rm -rf "${H6AI_DOCKER_DIR:?}" "${H6AI_ROOT:?}/_h6ai" /etc/h6ai /usr/local/sbin/h6ai-user
        info "removed the container, the h6ai-data volume, the image, $H6AI_DOCKER_DIR and $H6AI_ROOT/_h6ai"
    else
        (cd "$H6AI_DOCKER_DIR" && docker compose down) || warn "docker compose down failed"
        rm -f "$STATE" /usr/local/sbin/h6ai-user
        info "kept the h6ai-data volume (users, settings) and $H6AI_DOCKER_DIR. --uninstall --purge deletes them."
    fi
    info "Your files in $H6AI_ROOT are untouched."
    exit 0
fi
if [ "$UNINSTALL" = 1 ]; then
    step "Removing h6ai from nginx and PHP-FPM"
    for f in "${NGINX_SITE:-}" "${NGINX_SITE:-}.h6ai-new" "${NGINX_SITE_LINK:-}" "${FPM_POOL:-}" "${PHP_INI:-}" /usr/local/sbin/h6ai-user; do
        [ -n "$f" ] && { [ -e "$f" ] || [ -L "$f" ]; } && rm -f "$f" && info "removed $f"
    done
    # with --no-site (or by hand) a server block of the admin's includes h6ai's snippets
    own=$(grep -rlE '^[[:space:]]*include[[:space:]]+(/etc/nginx/)?h6ai/(server|large-files)\.conf' /etc/nginx 2>/dev/null \
        | grep -v '^/etc/nginx/h6ai/' || true)
    [ -z "$own" ] || warn "remove the h6ai includes (and the root for h6ai) from: $(echo "$own" | tr '\n' ' ')- nginx won't load them any more"
    if [ -d /etc/nginx/h6ai ]; then
        # trusted-html.map is the admin's: keep it unless purging
        if [ "$PURGE" = 1 ]; then rm -rf /etc/nginx/h6ai; else find /etc/nginx/h6ai -type f ! -name trusted-html.map -delete; fi
    fi
    if [ -n "$DISABLED_SITE" ] && [ -e "$DISABLED_SITE.h6ai-disabled" ]; then
        mv "$DISABLED_SITE.h6ai-disabled" "$DISABLED_SITE" && info "re-enabled $DISABLED_SITE"
    elif [ -n "$DISABLED_SITE" ] && [ -n "${DISABLED_SITE_TARGET:-}" ] && [ ! -e "$DISABLED_SITE" ]; then
        ln -s "$DISABLED_SITE_TARGET" "$DISABLED_SITE" && info "re-enabled $DISABLED_SITE"
    fi
    service_do reload "${FPM_SERVICE:-}" 2>/dev/null || true
    if nginx -t >/dev/null 2>&1; then service_do reload nginx 2>/dev/null || true; fi
    if [ "$PURGE" = 1 ]; then
        step "Purging h6ai data"
        rm -rf "${H6AI_ROOT:?}/_h6ai" "$LIB" /etc/h6ai
        info "removed $H6AI_ROOT/_h6ai, $LIB and /etc/h6ai"
        if id h6ai >/dev/null 2>&1; then
            if command -v userdel >/dev/null 2>&1; then userdel h6ai 2>/dev/null || true; else deluser h6ai 2>/dev/null || true; fi
            getent group h6ai >/dev/null 2>&1 && { groupdel h6ai 2>/dev/null || delgroup h6ai 2>/dev/null || true; }
            info "removed the h6ai system user"
        fi
    else
        rm -f "$STATE"
        info "kept $H6AI_ROOT/_h6ai (users, settings, activity log). --uninstall --purge deletes it."
    fi
    info "nginx and PHP were left installed. Your files in $H6AI_ROOT are untouched."
    exit 0
fi

# =================================================================================================
# install / upgrade
# =================================================================================================

# --- sources -------------------------------------------------------------------------------------
if [ -f "$HERE/_h6ai/public/index.php" ]; then
    SRC=$HERE/_h6ai                         # release bundle
elif [ -f "$HERE/build/_h6ai/public/index.php" ]; then
    SRC=$HERE/build/_h6ai                   # git checkout after npm run build
else
    die "no built h6ai found. Use a release bundle, or run 'npm ci && npm run build' in the checkout first."
fi
[ -f "$HERE/deploy/nginx/server.conf" ] || die "deploy/ is missing next to install.sh"
grep -q "H6AI_VERSION', '{" "$SRC/public/index.php" && die "$SRC is an unbuilt source tree, run 'npm run build'"
NEW_VERSION=$(sed -n "s/.*H6AI_VERSION', '\([^']*\)'.*/\1/p" "$SRC/public/index.php")

[ "$MODE" = native ] || [ "$H6AI_NO_SITE" = 0 ] || die "--no-site is for native installs; the Docker container brings its own nginx"
[ -z "$PREVIOUS_VERSION" ] || [ "$PREVIOUS_NO_SITE" = 1 ] || [ "$H6AI_NO_SITE" = 0 ] \
    || die "h6ai has its own server block here (${NGINX_SITE:-nginx site}); --no-site would remove it. Run --uninstall first, then install with --no-site."
if [ "$MODE" = docker ]; then HOW="with Docker"; else HOW="natively on ${PRETTY_NAME:-$ID}"; fi
if [ -n "$PREVIOUS_VERSION" ]; then
    step "Upgrading h6ai $PREVIOUS_VERSION to $NEW_VERSION $HOW"
else
    step "Installing h6ai $NEW_VERSION $HOW"
    H6AI_ROOT=$(ask "Folder to share" "$H6AI_ROOT")
    if [ "$H6AI_NO_SITE" = 0 ]; then
        H6AI_PORT=$(ask "HTTP port" "$H6AI_PORT")
        case $H6AI_PORT in ''|*[!0-9]*) die "the port must be a number" ;; esac
    fi
fi
case $H6AI_ROOT in /*) ;; *) die "the folder must be an absolute path" ;; esac
H6AI_ROOT=${H6AI_ROOT%/}
info "shared folder: $H6AI_ROOT"
if [ "$MODE" = docker ]; then
    info "listen:        ${H6AI_LISTEN:-*}:$H6AI_PORT"
elif [ "$H6AI_NO_SITE" = 1 ]; then
    info "nginx:         no server block (--no-site): you include h6ai/server.conf in your own"
else
    info "listen:        ${H6AI_LISTEN:-*}:$H6AI_PORT  server_name $H6AI_SERVER_NAME"
fi
confirm "Continue?" || die "aborted"
H6AI_MODE=$MODE

write_state() { # variable names -> $STATE (sourced by h6ai-user and the next run)
    mkdir -p /etc/h6ai
    {
        echo "# h6ai install, written by install.sh $(date -u +%Y-%m-%dT%H:%M:%SZ). Re-run the installer to change it."
        for var in "$@"; do
            eval "value=\${$var:-}"
            # shellcheck disable=SC2154 # assigned by eval
            echo "$var=$(quote "$value")"
        done
    } > "$STATE"
    chmod 0644 "$STATE"
}

URL_PORT=
[ "$H6AI_PORT" = 80 ] || URL_PORT=:$H6AI_PORT
GENERATED_PASSWORD=
summary() {
    public_host=${H6AI_LISTEN:-}
    [ "$H6AI_SERVER_NAME" = _ ] || public_host=${H6AI_SERVER_NAME%% *}
    [ -n "$public_host" ] || public_host=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo localhost)
    echo
    if [ "$MODE" = native ] && [ "$H6AI_NO_SITE" = 1 ]; then
        printf '%sh6ai %s is installed.%s nginx has its http-level part (%s); add the rest to your server block:\n' \
            "$BOLD" "$NEW_VERSION" "$RESET" "$NGINX_SITE"
        echo "              root $H6AI_ROOT;"
        echo "              include h6ai/large-files.conf;   # optional: sendfile, thread pool reads, gzip"
        echo "              include h6ai/server.conf;"
        echo "            Remove that block's own \"location /\", its PHP location and any location that matches"
        echo "            file types (e.g. location ~* \\.(jpg|css|js)\$): they would skip h6ai's permission check."
        echo "            Then: nginx -t && systemctl reload nginx. Details: docs/DEPLOYMENT.md"
        echo "  Admin:    /_h6ai/public/ on that site (System shows whether every file type reaches h6ai)"
    else
        printf '%sh6ai %s is ready.%s\n' "$BOLD" "$NEW_VERSION" "$RESET"
        echo "  Files:    http://$public_host$URL_PORT/          (shared folder $H6AI_ROOT)"
        echo "  Admin:    http://$public_host$URL_PORT/_h6ai/public/"
    fi
    if [ -n "$GENERATED_PASSWORD" ]; then
        echo "  Login:    $ADMIN_NAME / $GENERATED_PASSWORD"
        echo "            ${DIM}shown once: sign in and change it in the account menu${RESET}"
    fi
    echo "  Users:    h6ai-user list | add NAME [--admin] | passwd NAME"
    if [ "$MODE" = docker ]; then
        echo "  Docker:   $DOCKER_DIR (cd there for docker compose logs, restart, ...)"
    else
        echo "  Config:   $NGINX_SITE, $FPM_POOL"
    fi
    echo "  Upgrade:  run install.sh from a newer release. Remove: install.sh --uninstall"
}

read_secret() { # prompt -> line typed without echo
    printf '%s' "$1" >&2
    stty -echo 2>/dev/null || true
    read -r secret || secret=
    stty echo 2>/dev/null || true
    printf '\n' >&2
    printf '%s' "$secret"
}

# =================================================================================================
# Docker: the release's Dockerfile and compose.yaml in /opt/h6ai, image built from the bundle
# =================================================================================================
if [ "$MODE" = docker ]; then
    have_docker || die "Docker with the compose plugin is needed: https://docs.docker.com/engine/install/"
    for f in Dockerfile compose.yaml .dockerignore docker deploy; do
        [ -e "$HERE/$f" ] || die "$f is missing next to install.sh"
    done
    password=
    if [ -z "$PREVIOUS_VERSION" ]; then
        if [ -n "$ADMIN_PASSWORD_FILE" ]; then
            password=$(head -n 1 "$ADMIN_PASSWORD_FILE")
        elif [ "$INTERACTIVE" = 1 ]; then
            info "password for the admin \"$ADMIN_NAME\" (at least 8 characters), or Enter to generate one"
            password=$(read_secret "    Password: ")
            if [ -n "$password" ]; then
                [ "${#password}" -ge 8 ] || die "the password needs at least 8 characters"
                [ "$(read_secret "    Repeat password: ")" = "$password" ] || die "the passwords do not match"
            fi
        fi
    fi

    step "Preparing $DOCKER_DIR"
    mkdir -p "$DOCKER_DIR" "$H6AI_ROOT"
    for f in Dockerfile compose.yaml .dockerignore .env.example docker deploy; do
        [ -e "$HERE/$f" ] || continue
        rm -rf "${DOCKER_DIR:?}/$f"
        cp -a "$HERE/$f" "$DOCKER_DIR/$f"
    done
    rm -rf "$DOCKER_DIR/_h6ai"
    cp -a "$SRC" "$DOCKER_DIR/_h6ai"
    # a fixed project name keeps the container and the h6ai-data volume across upgrades
    {
        echo "# h6ai Docker settings, written by install.sh. Re-run the installer to change them."
        echo "COMPOSE_PROJECT_NAME=h6ai"
        echo "H6AI_SOURCE=prebuilt"
        echo "H6AI_FILES=$H6AI_ROOT"
        echo "H6AI_BIND=${H6AI_LISTEN:-0.0.0.0}"
        echo "H6AI_PORT=$H6AI_PORT"
        echo "H6AI_ADMIN_USER=$ADMIN_NAME"
    } > "$DOCKER_DIR/.env"
    chmod 0600 "$DOCKER_DIR/.env"

    step "Building the image and starting the container (the first build takes a few minutes)"
    LOG=/var/log/h6ai-docker.log
    # the chosen password only reaches the first start (it's not written to .env)
    if ! (cd "$DOCKER_DIR" && H6AI_ADMIN_PASSWORD=$password docker compose up -d --build) > "$LOG" 2>&1; then
        tail -n 30 "$LOG" >&2
        die "docker compose up failed, full log: $LOG"
    fi
    cid=$(cd "$DOCKER_DIR" && docker compose ps -q h6ai)
    health=
    for _ in $(seq 120); do
        health=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)
        [ "$health" = healthy ] && break
        sleep 1
    done
    if [ "$health" = healthy ]; then
        info "container healthy"
    else
        warn "the container isn't healthy yet, see: cd $DOCKER_DIR && docker compose logs"
    fi
    if [ -z "$PREVIOUS_VERSION" ] && [ -z "$password" ]; then
        GENERATED_PASSWORD=$(cd "$DOCKER_DIR" && docker compose logs h6ai 2>/dev/null \
            | sed -n 's/.*\[init\]     \([^ ]*\)$/\1/p' | tail -n 1 | tr -d '\r')
    fi

    mkdir -p /usr/local/sbin
    install -m 0755 "$HERE/deploy/h6ai-user" /usr/local/sbin/h6ai-user
    H6AI_VERSION=$NEW_VERSION
    H6AI_DOCKER_DIR=$DOCKER_DIR
    write_state H6AI_MODE H6AI_VERSION H6AI_ROOT H6AI_PORT H6AI_LISTEN H6AI_DOCKER_DIR
    summary
    exit 0
fi

# --- packages ------------------------------------------------------------------------------------
# version_ge A B: A >= B for dotted numbers
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]; }

OPTIONAL_MISSING=
install_optional() { # installer-command package...
    cmd=$1; shift
    for pkg in "$@"; do
        # shellcheck disable=SC2086 # $cmd is a command with arguments
        $cmd "$pkg" >/dev/null 2>&1 || OPTIONAL_MISSING="$OPTIONAL_MISSING $pkg"
    done
}

php_repo_ok() {
    [ "$ALLOW_PHP_REPO" = 1 ] && return 0
    [ "$INTERACTIVE" = 1 ] || return 1
    confirm "$1 Add it?"
}

install_debian() {
    export DEBIAN_FRONTEND=noninteractive
    step "Installing packages (apt)"
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ca-certificates curl >/dev/null
    PHP_V=$(apt-cache policy php-fpm 2>/dev/null | sed -n 's/.*Candidate: \([0-9]*:\)\{0,1\}\([0-9]*\.[0-9]*\).*/\2/p')
    if [ -z "$PHP_V" ] || ! version_ge "$PHP_V" 8.2; then
        if [ "$ID" = ubuntu ]; then
            php_repo_ok "Ubuntu ${VERSION_ID:-} has PHP ${PHP_V:-none}, h6ai needs 8.2 or later. The PPA ppa:ondrej/php has current PHP." \
                || die "PHP ${PHP_V:-none} is too old. Re-run with --allow-php-repo to use ppa:ondrej/php."
            info "adding ppa:ondrej/php"
            apt-get install -y -qq --no-install-recommends software-properties-common gpg-agent >/dev/null
            add-apt-repository -y ppa:ondrej/php >/dev/null
        else
            php_repo_ok "Debian ${VERSION_ID:-} has PHP ${PHP_V:-none}, h6ai needs 8.2 or later. packages.sury.org has current PHP." \
                || die "PHP ${PHP_V:-none} is too old. Re-run with --allow-php-repo to use packages.sury.org."
            info "adding packages.sury.org/php"
            curl -fsSLo /tmp/debsuryorg-archive-keyring.deb https://packages.sury.org/debsuryorg-archive-keyring.deb
            dpkg -i /tmp/debsuryorg-archive-keyring.deb >/dev/null && rm -f /tmp/debsuryorg-archive-keyring.deb
            echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ ${VERSION_CODENAME:?} main" \
                > /etc/apt/sources.list.d/php-sury.list
        fi
        apt-get update -qq
        PHP_V=$(apt-cache policy php-fpm 2>/dev/null | sed -n 's/.*Candidate: \([0-9]*:\)\{0,1\}\([0-9]*\.[0-9]*\).*/\2/p')
        if [ -z "$PHP_V" ] || ! version_ge "$PHP_V" 8.2; then die "no PHP >= 8.2 available"; fi
    fi
    pkgs="nginx php$PHP_V-fpm php$PHP_V-cli php$PHP_V-gd php$PHP_V-mbstring"
    apt-cache show "php$PHP_V-opcache" >/dev/null 2>&1 && pkgs="$pkgs php$PHP_V-opcache"
    info "nginx, PHP $PHP_V"
    # shellcheck disable=SC2086
    apt-get install -y -qq --no-install-recommends $pkgs >/dev/null
    install_optional "apt-get install -y -qq --no-install-recommends" zip
    [ "$TOOLS" = 1 ] && install_optional "apt-get install -y -qq --no-install-recommends" ffmpeg imagemagick ghostscript
    PHP_BIN=/usr/bin/php$PHP_V
    FPM_BIN=/usr/sbin/php-fpm$PHP_V
    FPM_SERVICE=php$PHP_V-fpm
    FPM_POOL=/etc/php/$PHP_V/fpm/pool.d/h6ai.conf
    PHP_INI=/etc/php/$PHP_V/fpm/conf.d/90-h6ai.ini
    FPM_SOCK=/run/php/h6ai.sock
    if [ -d /etc/nginx/sites-enabled ]; then
        NGINX_SITE=/etc/nginx/sites-available/h6ai.conf
        NGINX_SITE_LINK=/etc/nginx/sites-enabled/h6ai.conf
    else
        NGINX_SITE=/etc/nginx/conf.d/h6ai.conf
        NGINX_SITE_LINK=
    fi
}

install_rhel() {
    step "Installing packages (dnf)"
    # EL 8/9 ship old PHP by default and newer versions as module streams: use the newest
    streams=$(dnf -q module list php 2>/dev/null | awk '$1 == "php" && $2 ~ /^[0-9]+\.[0-9]+$/ {print $2}' | sort -t. -k1,1n -k2,2n | uniq)
    if [ -n "$streams" ]; then
        best=$(printf '%s\n' "$streams" | tail -n1)
        version_ge "$best" 8.2 || die "the newest PHP module stream is $best, h6ai needs 8.2 or later"
        info "enabling the php:$best module stream"
        dnf -y -q module reset php >/dev/null
        dnf -y -q module enable "php:$best" >/dev/null
    fi
    PHP_V=$(dnf -q info php-fpm 2>/dev/null | sed -n 's/^Version *: *\([0-9]*\.[0-9]*\).*/\1/p' | sort -t. -k1,1n -k2,2n | tail -n1)
    if [ -z "$PHP_V" ] || ! version_ge "$PHP_V" 8.2; then die "PHP ${PHP_V:-none} is too old, h6ai needs 8.2 or later"; fi
    info "nginx, PHP $PHP_V"
    # EL images ship curl-minimal, which conflicts with the curl package
    curl=; command -v curl >/dev/null 2>&1 || curl=curl
    dnf -y -q install nginx php-fpm php-cli php-gd php-mbstring php-opcache php-process $curl >/dev/null
    install_optional "dnf -y -q install" zip
    if [ "$TOOLS" = 1 ]; then
        # ffmpeg: Fedora's ffmpeg-free, or RPM Fusion's ffmpeg if that repository is enabled
        dnf -y -q install ffmpeg-free >/dev/null 2>&1 || install_optional "dnf -y -q install" ffmpeg
        install_optional "dnf -y -q install" ImageMagick ghostscript
    fi
    PHP_BIN=/usr/bin/php
    FPM_BIN=/usr/sbin/php-fpm
    FPM_SERVICE=php-fpm
    FPM_POOL=/etc/php-fpm.d/h6ai.conf
    PHP_INI=/etc/php.d/90-h6ai.ini
    FPM_SOCK=/run/php-fpm/h6ai.sock
    NGINX_SITE=/etc/nginx/conf.d/h6ai.conf
    NGINX_SITE_LINK=
}

install_alpine() {
    step "Installing packages (apk)"
    apk update -q
    PHP_N=
    for n in 85 84 83 82; do
        if [ -n "$(apk search -q -e "php$n-fpm" 2>/dev/null)" ]; then PHP_N=$n; break; fi
    done
    [ -n "$PHP_N" ] || die "no PHP >= 8.2 package found"
    PHP_V="${PHP_N%?}.${PHP_N#?}"
    info "nginx, PHP $PHP_V"
    p=php$PHP_N
    apk add -q nginx curl "$p" "$p-fpm" "$p-gd" "$p-mbstring" "$p-opcache" "$p-exif" "$p-session" \
        "$p-posix" "$p-ctype" "$p-fileinfo" "$p-iconv" coreutils tar >/dev/null
    install_optional "apk add -q" zip
    [ "$TOOLS" = 1 ] && install_optional "apk add -q" ffmpeg imagemagick ghostscript
    PHP_BIN=/usr/bin/php$PHP_N
    FPM_BIN=/usr/sbin/php-fpm$PHP_N
    FPM_SERVICE=php-fpm$PHP_N
    FPM_POOL=/etc/php$PHP_N/php-fpm.d/h6ai.conf
    PHP_INI=/etc/php$PHP_N/conf.d/90-h6ai.ini
    # created by the php-fpm init script (pid file directory)
    FPM_SOCK=/run/php-fpm$PHP_N/h6ai.sock
    NGINX_SITE=/etc/nginx/http.d/h6ai.conf
    NGINX_SITE_LINK=
}

"install_$FAMILY"
[ -z "$OPTIONAL_MISSING" ] || warn "not available here, skipped:$OPTIONAL_MISSING (thumbnails for those types stay off)"

# --- CVE-2026-109618 ---------------------------------------------------------------------------
# Fixed by version (8.2.35 / 8.3.36 / 8.4.27 / 8.5.12) or by a distribution backport, which Debian
# and Ubuntu name in the package changelog. h6ai's own check (admin System tab) is the same code.
PHP_FULL=$("$PHP_BIN" -r 'echo PHP_VERSION;')
# shellcheck disable=SC2016 # PHP code
CVE_FIX=$("$PHP_BIN" -r 'require $argv[1]; echo Setup::is_php_patched(PHP_VERSION) ? "version" : (Setup::has_backported_fix(PHP_VERSION) ? "backport" : "");' \
    "$SRC/private/php/core/class-setup.php" 2>/dev/null) || CVE_FIX=
if [ -z "$CVE_FIX" ] && [ "$FAMILY" = debian ] && apt-get changelog "php$PHP_V-common" 2>/dev/null | grep -q CVE-2026-109618; then
    CVE_FIX=backport   # changelog not installed locally (minimised image), found online
fi
case $CVE_FIX in
    version) info "PHP $PHP_FULL: CVE-2026-109618 fixed" ;;
    backport) info "PHP $PHP_FULL: CVE-2026-109618 fixed (distribution backport)" ;;
    *)
        warn "PHP $PHP_FULL is affected by CVE-2026-109618 (remote code execution). Update PHP to 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12 or later."
        if [ "$ALLOW_UNPATCHED" = 1 ] || { [ "$INTERACTIVE" = 1 ] && confirm "Install anyway? nginx and PHP still block the main attack path (multipart bodies)."; }; then
            warn "continuing with an affected PHP"
        else
            die "stopping. Update PHP, or re-run with --allow-unpatched-php."
        fi
        ;;
esac

# --- checks --------------------------------------------------------------------------------------
NGINX_FEATURES=$(nginx -V 2>&1)
case $NGINX_FEATURES in
    *http_auth_request_module*) ;;
    *) die "this nginx is built without the auth_request module, which h6ai's permission checks need" ;;
esac
NGINX_USER=$(sed -n 's/^[[:space:]]*user[[:space:]]\{1,\}\([^[:space:];]*\).*/\1/p' /etc/nginx/nginx.conf | head -n1)
case $FAMILY in debian) : "${NGINX_USER:=www-data}" ;; *) : "${NGINX_USER:=nginx}" ;; esac
id "$NGINX_USER" >/dev/null 2>&1 || die "the nginx user '$NGINX_USER' doesn't exist"
NGINX_GROUP=$(id -gn "$NGINX_USER")

# --- system user, folders ------------------------------------------------------------------------
step "Setting up the h6ai system user and folders"
if ! id h6ai >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
        nologin=$(command -v nologin || echo /sbin/nologin)
        useradd --system --user-group --home-dir "$LIB" --no-create-home --shell "$nologin" h6ai
    else
        addgroup -S h6ai
        adduser -S -D -H -h "$LIB" -s /sbin/nologin -G h6ai h6ai
    fi
    info "created system user h6ai (PHP-FPM runs as it)"
fi
mkdir -p "$LIB/sessions" /etc/h6ai
chown h6ai:h6ai "$LIB" "$LIB/sessions"
chmod 0750 "$LIB"
chmod 0700 "$LIB/sessions"

if [ ! -d "$H6AI_ROOT" ]; then
    mkdir -p "$H6AI_ROOT"
    chmod 0755 "$H6AI_ROOT"
    info "created $H6AI_ROOT"
fi
# nginx and PHP both need to read the share
for u in h6ai "$NGINX_USER"; do
    if command -v runuser >/dev/null 2>&1; then
        runuser -u "$u" -- test -r "$H6AI_ROOT" -a -x "$H6AI_ROOT" || warn "$u can't read $H6AI_ROOT: make it (and its parents) readable, e.g. chmod o+rx"
    fi
done

step "Installing h6ai $NEW_VERSION into $H6AI_ROOT/_h6ai"
"$HERE/deploy/install-app.sh" "$SRC" "$H6AI_ROOT/_h6ai" h6ai h6ai >/dev/null
mkdir -p /usr/local/sbin
install -m 0755 "$HERE/deploy/h6ai-user" /usr/local/sbin/h6ai-user

# --- PHP-FPM -------------------------------------------------------------------------------------
step "Configuring PHP-FPM (pool h6ai, $FPM_SOCK)"
INI=$HERE/deploy/php/h6ai.ini
# "key = value" lines of h6ai.ini; ${VAR:-default} means default outside Docker
ini_lines() {
    sed -n 's/^\([a-z_.]*\)[[:space:]]*=[[:space:]]*\(.*\)$/\1=\2/p' "$INI" | sed 's/=\${[A-Z_]*:-\(.*\)}$/=\1/'
}
MEM_MB=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 2048)
CHILDREN=$((MEM_MB / 64))
[ "$CHILDREN" -lt 8 ] && CHILDREN=8
[ "$CHILDREN" -gt 32 ] && CHILDREN=32
JIT_OFF=0
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Enforcing ]; then
    JIT_OFF=1   # the JIT needs execmem, which SELinux denies to httpd_t
fi
{
    echo "; h6ai PHP-FPM pool, written by install.sh. Re-run the installer to change it."
    echo "; PHP settings come from deploy/php/h6ai.ini (process-wide ones: $PHP_INI)."
    echo "[h6ai]"
    echo "user = h6ai"
    echo "group = h6ai"
    echo "listen = $FPM_SOCK"
    echo "listen.owner = $NGINX_USER"
    echo "listen.group = $NGINX_GROUP"
    echo "listen.mode = 0660"
    echo
    echo "pm = dynamic"
    echo "pm.max_children = $CHILDREN"
    echo "pm.start_servers = 2"
    echo "pm.min_spare_servers = 2"
    echo "pm.max_spare_servers = 6"
    echo "pm.max_requests = 1000"
    echo
    echo "; archive downloads of big folders can take hours"
    echo "request_terminate_timeout = 0"
    echo "catch_workers_output = yes"
    echo "decorate_workers_output = no"
    echo "security.limit_extensions = .php"
    echo
    echo "php_admin_value[session.save_path] = $LIB/sessions"
    ini_lines | while IFS='=' read -r key val; do
        case $key in opcache.*|realpath_cache_*|error_log|session.save_path) continue ;; esac
        echo "php_admin_value[$key] = $val"
    done
} > "$FPM_POOL"
{
    echo "; h6ai: process-wide PHP-FPM settings, written by install.sh (pool settings: $FPM_POOL)."
    ini_lines | while IFS='=' read -r key val; do
        case $key in
            opcache.jit) [ "$JIT_OFF" = 1 ] && val=disable ;;
            opcache.*|realpath_cache_*) ;;
            *) continue ;;
        esac
        echo "$key = $val"
    done
} > "$PHP_INI"
chmod 0644 "$FPM_POOL" "$PHP_INI"
"$FPM_BIN" -t >/dev/null 2>&1 || { "$FPM_BIN" -t; die "PHP-FPM rejects the configuration ($FPM_POOL)"; }

# --- nginx ----------------------------------------------------------------------------------------
step "Configuring nginx ($NGINX_SITE)"
mkdir -p /etc/nginx/h6ai
for f in http.conf server.conf large-files.conf; do
    install -m 0644 "$HERE/deploy/nginx/$f" "/etc/nginx/h6ai/$f"
done
[ -e /etc/nginx/h6ai/trusted-html.map ] || install -m 0644 "$HERE/deploy/nginx/trusted-html.map" /etc/nginx/h6ai/trusted-html.map
case $NGINX_FEATURES in
    *--with-threads*) ;;
    *) sed -i 's/^aio threads;/# aio threads;  (this nginx has no thread pools)/' /etc/nginx/h6ai/large-files.conf ;;
esac

DEFAULT_SERVER=
[ "$H6AI_SERVER_NAME" = _ ] && DEFAULT_SERVER=" default_server"
if [ -n "$H6AI_LISTEN" ]; then
    case $H6AI_LISTEN in *:*) LISTENS="[$H6AI_LISTEN]:$H6AI_PORT" ;; *) LISTENS="$H6AI_LISTEN:$H6AI_PORT" ;; esac
else
    LISTENS=$H6AI_PORT
    [ -e /proc/net/if_inet6 ] && LISTENS="$LISTENS [::]:$H6AI_PORT"
fi

# A site file edited since the last run (by hand, or by certbot) is kept; ours goes next to it.
SITE_OUT=$NGINX_SITE
if [ "$H6AI_NO_SITE" = 0 ] && [ -f "$NGINX_SITE" ] && [ -n "${SITE_SUM:-}" ] && [ "$(cksum < "$NGINX_SITE")" != "$SITE_SUM" ]; then
    SITE_OUT=$NGINX_SITE.h6ai-new
fi
# Keep what is there, to put it back if nginx doesn't take the new configuration.
SITE_BACKUP=
if [ -f "$SITE_OUT" ]; then
    SITE_BACKUP=$(mktemp)
    cp -p "$SITE_OUT" "$SITE_BACKUP"
fi
LINK_EXISTED=0
if [ -n "$NGINX_SITE_LINK" ] && { [ -e "$NGINX_SITE_LINK" ] || [ -L "$NGINX_SITE_LINK" ]; }; then LINK_EXISTED=1; fi
DISABLED_NOW=0
undo_site() {
    if [ -n "$SITE_BACKUP" ]; then mv -f "$SITE_BACKUP" "$SITE_OUT"; else rm -f "$SITE_OUT"; fi
    [ "$LINK_EXISTED" = 1 ] || [ -z "$NGINX_SITE_LINK" ] || rm -f "$NGINX_SITE_LINK"
    if [ "$DISABLED_NOW" = 1 ]; then
        if [ -e "$DISABLED_SITE.h6ai-disabled" ]; then mv "$DISABLED_SITE.h6ai-disabled" "$DISABLED_SITE"; else ln -s "$DISABLED_SITE_TARGET" "$DISABLED_SITE"; fi
    fi
}

if [ "$H6AI_NO_SITE" = 1 ]; then
    # --no-site: the http-level part only; a server block of the admin's includes h6ai/server.conf
    {
        echo "# h6ai, written by install.sh (--no-site): the http-level part only. Your own server block"
        echo "# includes h6ai/server.conf, see docs/DEPLOYMENT.md. Upgrades rewrite this file."
        echo "include h6ai/http.conf;"
        echo
        echo "upstream h6ai_php {"
        echo "    server unix:$FPM_SOCK;"
        echo "}"
    } > "$SITE_OUT"
    chmod 0644 "$SITE_OUT"
    SITE_SUM=
else
    # The distribution's welcome site also claims default_server on port 80: step aside for it.
    if [ -n "$DEFAULT_SERVER" ] && [ -z "$H6AI_LISTEN" ] && [ -z "$DISABLED_SITE" ]; then
        for site in /etc/nginx/sites-enabled/default /etc/nginx/http.d/default.conf /etc/nginx/conf.d/default.conf; do
            if { [ -e "$site" ] || [ -L "$site" ]; } && grep -Eq "listen[[:space:]]+(\[::\]:)?${H6AI_PORT}[[:space:]]+default_server" "$site"; then
                if [ -L "$site" ]; then
                    DISABLED_SITE_TARGET=$(readlink "$site")
                    rm -f "$site"
                else
                    mv "$site" "$site.h6ai-disabled"
                fi
                DISABLED_SITE=$site
                DISABLED_NOW=1
                info "disabled the default site $site (it also claims port $H6AI_PORT; --uninstall restores it)"
            fi
        done
    fi

    {
        echo "# h6ai, written by install.sh. Upgrades keep this file once you edit it (e.g. certbot)."
        echo "# The h6ai parts live in /etc/nginx/h6ai/. TLS: certbot --nginx -d your.host works on this file."
        echo "include h6ai/http.conf;"
        echo
        echo "upstream h6ai_php {"
        echo "    server unix:$FPM_SOCK;"
        echo "}"
        echo
        echo "server {"
        for l in $LISTENS; do echo "    listen $l$DEFAULT_SERVER;"; done
        echo "    server_name $H6AI_SERVER_NAME;"
        echo "    root \"$H6AI_ROOT\";"
        echo
        echo "    access_log /var/log/nginx/h6ai.access.log;"
        echo "    error_log /var/log/nginx/h6ai.error.log;"
        echo
        echo "    include h6ai/large-files.conf;"
        echo "    include h6ai/server.conf;"
        echo "}"
    } > "$SITE_OUT"
    chmod 0644 "$SITE_OUT"
    if [ "$SITE_OUT" = "$NGINX_SITE" ]; then
        SITE_SUM=$(cksum < "$NGINX_SITE")
    else
        info "kept your edited $NGINX_SITE; the installer's version is in $SITE_OUT"
    fi
fi
[ -z "$NGINX_SITE_LINK" ] || ln -sf "$NGINX_SITE" "$NGINX_SITE_LINK"
mkdir -p /var/log/nginx
if ! NGINX_TEST=$(nginx -t 2>&1); then
    printf '%s\n' "$NGINX_TEST" >&2
    undo_site
    die "nginx rejects the configuration (left as it was). Another site may use port $H6AI_PORT: try --port, --listen or --server-name."
fi
# Another server block with the same name on the same port: nginx only warns, and keeps sending
# those visitors to whichever block it read first.
conflicts=
if [ "$H6AI_NO_SITE" = 0 ] && [ "$H6AI_SERVER_NAME" != _ ]; then
    for name in $H6AI_SERVER_NAME; do
        if printf '%s\n' "$NGINX_TEST" | grep -F "conflicting server name \"$name\" on " | grep -q ":$H6AI_PORT, ignored"; then
            conflicts="$conflicts $name"
        fi
    done
fi
if [ -n "$conflicts" ]; then
    others=$(nginx -T 2>/dev/null | awk -v names="$conflicts " '
        /^# configuration file / { file = $4; sub(/:$/, "", file) }
        $1 == "server_name" { for (i = 2; i <= NF; i++) { n = $i; sub(/;$/, "", n); if (index(names, " " n " ")) print file } }' \
        | grep -v -x -e "$NGINX_SITE" -e "${NGINX_SITE_LINK:-/nonexistent}" | sort -u | tr '\n' ' ' | sed 's/ $//')
    undo_site
    die "another nginx site already answers for${conflicts} on port $H6AI_PORT (${others:-see nginx -T}). nginx would keep sending visitors there, so nothing was changed. Change or remove that site, pick another --server-name or --port, or add h6ai to that site's server block yourself with --no-site (docs/DEPLOYMENT.md)."
fi
[ -z "$SITE_BACKUP" ] || rm -f "$SITE_BACKUP"

# --- SELinux, firewall ------------------------------------------------------------------------------
if [ "$JIT_OFF" = 1 ] || { command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = Permissive ]; }; then
    step "Labelling files for SELinux"
    command -v semanage >/dev/null 2>&1 || ! command -v dnf >/dev/null 2>&1 \
        || dnf -y -q install policycoreutils-python-utils >/dev/null || true
    command -v semanage >/dev/null 2>&1 || die "SELinux is on, but semanage is missing (package policycoreutils-python-utils)"
    label() { semanage fcontext -a -t "$1" "$2" 2>/dev/null || semanage fcontext -m -t "$1" "$2"; }
    label httpd_sys_content_t "$H6AI_ROOT(/.*)?"
    label httpd_sys_rw_content_t "$H6AI_ROOT/_h6ai/(public/cache|private/cache|private/data)(/.*)?"
    label httpd_sys_rw_content_t "$LIB(/.*)?"
    restorecon -R "$H6AI_ROOT" "$LIB"
    semanage port -a -t http_port_t -p tcp "$H6AI_PORT" 2>/dev/null || true
    [ "$JIT_OFF" = 1 ] && info "PHP's JIT is off: SELinux denies it executable memory"
fi
if [ "$FIREWALL" = 1 ] && [ "$H6AI_NO_SITE" = 0 ]; then
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        firewall-cmd -q --permanent --add-port="$H6AI_PORT/tcp" && firewall-cmd -q --reload
        info "firewalld: opened port $H6AI_PORT/tcp"
    elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow "$H6AI_PORT/tcp" >/dev/null
        info "ufw: opened port $H6AI_PORT/tcp"
    fi
fi

# --- state (also read by h6ai-user) --------------------------------------------------------------
H6AI_VERSION=$NEW_VERSION
write_state H6AI_MODE H6AI_VERSION H6AI_ROOT H6AI_PORT H6AI_LISTEN H6AI_SERVER_NAME H6AI_NO_SITE PHP_BIN FPM_BIN FPM_SERVICE \
    FPM_POOL PHP_INI FPM_SOCK NGINX_SITE NGINX_SITE_LINK SITE_SUM DISABLED_SITE DISABLED_SITE_TARGET

# --- first admin ----------------------------------------------------------------------------------
if [ "$NO_ADMIN" = 0 ] && ! h6ai-user has-admin; then
    step "Creating the admin user \"$ADMIN_NAME\""
    if [ -n "$ADMIN_PASSWORD_FILE" ]; then
        h6ai-user add "$ADMIN_NAME" --admin --password-stdin < "$ADMIN_PASSWORD_FILE"
    elif [ "$INTERACTIVE" = 1 ]; then
        info "choose a password (at least 8 characters), or press Enter twice to generate one"
        if ! h6ai-user add "$ADMIN_NAME" --admin; then
            GENERATED_PASSWORD=$(h6ai-user add "$ADMIN_NAME" --admin --generate)
        fi
    else
        GENERATED_PASSWORD=$(h6ai-user add "$ADMIN_NAME" --admin --generate)
    fi
fi

# --- services -------------------------------------------------------------------------------------
step "Starting PHP-FPM and nginx"
STARTED=1
if service_do enable "$FPM_SERVICE" >/dev/null 2>&1 && service_do enable nginx >/dev/null 2>&1; then
    # running already: load the new pool and site
    service_do restart "$FPM_SERVICE" >/dev/null
    service_do reload nginx >/dev/null
else
    STARTED=0
    warn "no service manager found. Start the daemons yourself: $FPM_BIN && nginx"
fi

URL_HOST=${H6AI_LISTEN:-127.0.0.1}
case $URL_HOST in *:*) URL_HOST="[$URL_HOST]" ;; esac
if [ "$STARTED" = 1 ] && [ "$H6AI_NO_SITE" = 0 ]; then
    check_host=localhost
    [ "$H6AI_SERVER_NAME" = _ ] || check_host=${H6AI_SERVER_NAME%% *}
    sleep 1
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $check_host" "http://$URL_HOST$URL_PORT/" || true)
    private=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $check_host" "http://$URL_HOST$URL_PORT/_h6ai/private/conf/options.json" || true)
    if [ "$code" = 200 ] && [ "$private" = 403 ]; then
        info "check: index 200, private files 403"
    else
        warn "check failed: index $code (want 200), private files $private (want 403). Logs: /var/log/nginx/h6ai.error.log"
    fi
fi

summary

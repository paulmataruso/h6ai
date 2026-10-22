#!/bin/sh
# Container start-up: install/update h6ai into the web root, first admin, sample data.
set -eu

WWW=/srv/www
H6AI=$WWW/_h6ai
SRC=/opt/h6ai/_h6ai
WEB_USER=www-data
HERE=/usr/local/share/h6ai

# --- install / update the application ---------------------------------------------------------
# The web root may be a host directory, so the app is copied in on every start. Only code is
# replaced; local options, data (users, settings), caches and custom ext/ files are kept.
echo "[init] installing h6ai into $H6AI"
version=$("$HERE/install-app.sh" "$SRC" "$H6AI" "$WEB_USER")
echo "[init] h6ai $version installed"

# Local option overrides: a bind mount wins, otherwise an optional copy baked into the image.
if [ ! -e "$H6AI/private/conf/options.local.json" ] && [ -f /etc/h6ai/options.local.json ]; then
    cp /etc/h6ai/options.local.json "$H6AI/private/conf/options.local.json"
fi

mkdir -p /var/lib/php/sessions
chown "$WEB_USER:$WEB_USER" /var/lib/php/sessions
chmod 0700 /var/lib/php/sessions

# --- first admin --------------------------------------------------------------------------------
# H6AI_PASSHASH enables the bootstrap login instead (development and tests): user "admin" with
# that password, only while no admin user exists.
create_admin() {
    name=${H6AI_ADMIN_USER:-admin}
    if [ -n "${H6AI_ADMIN_PASSWORD_FILE:-}" ]; then
        h6ai-user add "$name" --admin --password-stdin < "$H6AI_ADMIN_PASSWORD_FILE" || return 1
        echo "[init] created admin user \"$name\" (password from $H6AI_ADMIN_PASSWORD_FILE)"
    elif [ -n "${H6AI_ADMIN_PASSWORD:-}" ]; then
        printf '%s\n' "$H6AI_ADMIN_PASSWORD" | h6ai-user add "$name" --admin --password-stdin || return 1
        echo "[init] created admin user \"$name\" (password from H6AI_ADMIN_PASSWORD)"
    else
        password=$(h6ai-user add "$name" --admin --generate) || return 1
        echo "[init] ------------------------------------------------------------------------"
        echo "[init] Created the first admin user \"$name\" with the password:"
        echo "[init]     $password"
        echo "[init] Sign in at /_h6ai/public/ and change it in the account menu."
        echo "[init] ------------------------------------------------------------------------"
    fi
}
if [ -n "${H6AI_PASSHASH:-}${H5AI_PASSHASH:-}" ]; then
    echo "[init] bootstrap admin login enabled (H6AI_PASSHASH)"
elif ! h6ai-user has-admin; then
    create_admin || echo "[init] WARNING: no admin user. Create one: docker compose exec h6ai h6ai-user add NAME --admin"
fi

# --- sample data (development and tests) --------------------------------------------------------
if [ "${H6AI_SEED:-0}" = "1" ]; then
    "$HERE/seed.sh"
fi

# Large performance test file, generated in the background (takes a while for several GiB).
if [ "${H6AI_SEED:-0}" = "1" ] && [ "${H6AI_SEED_BIG_GB:-0}" != "0" ] && [ -f "$WWW/.h6ai-seeded" ]; then
    "$HERE/bigfile.sh" "$WWW/big" "$H6AI_SEED_BIG_GB" &
fi

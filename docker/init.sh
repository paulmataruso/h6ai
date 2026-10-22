#!/bin/sh
# Container start-up: install/update h6ai into the web root, writable dirs, sample data.
set -eu

WWW=/srv/www
H6AI=$WWW/_h6ai
SRC=/opt/h6ai/_h6ai
WEB_USER=www-data
HERE=/usr/local/share/h6ai

# --- install / update the application ---------------------------------------------------------
# The web root may be a host directory, so the app is copied in on every start. Only code is
# replaced; local options, data (users, settings), caches and custom ext/ files are kept.
echo "[init] installing h6ai $(sed -n "s/.*H6AI_VERSION', '\([^']*\)'.*/\1/p" "$SRC/public/index.php") into $H6AI"
mkdir -p "$H6AI/public" "$H6AI/private/conf"
for p in public/js public/css private/php private/bin private/conf/l10n; do
    rm -rf "${H6AI:?}/$p"
    cp -a "$SRC/$p" "$H6AI/$p"
done
# images: overlay, so custom icon themes added next to the bundled ones survive updates
mkdir -p "$H6AI/public/images"
cp -a "$SRC/public/images/." "$H6AI/public/images/"
cp -a "$SRC/public/index.php" "$H6AI/public/index.php"
[ -d "$H6AI/public/ext" ] || cp -a "$SRC/public/ext" "$H6AI/public/ext"
for f in "$SRC"/private/conf/*.json; do
    [ "$(basename "$f")" = "options.local.json" ] && continue
    cp -a "$f" "$H6AI/private/conf/"
done
for f in "$SRC"/*.md "$SRC"/LICENSE; do
    [ -f "$f" ] && cp -a "$f" "$H6AI/"
done

# Local option overrides: a bind mount wins, otherwise use the copy baked into the image.
if [ ! -e "$H6AI/private/conf/options.local.json" ] && [ -f /etc/h6ai/options.local.json ]; then
    cp /etc/h6ai/options.local.json "$H6AI/private/conf/options.local.json"
fi

# Code is root owned and read-only for PHP. Only these folders are writable by PHP:
#   public/cache  - thumbnails (served statically)
#   private/cache - rate limiter, command detection, folder size, compiled config caches
#   private/data  - users, roles, permissions, settings, activity log (named volume)
find "$H6AI/public/js" "$H6AI/public/css" "$H6AI/public/images" "$H6AI/private/php" \
     "$H6AI/private/bin" "$H6AI/private/conf/l10n" "$H6AI/public/index.php" \
     \( -type d -exec chmod 0755 {} + \) -o \( -type f -exec chmod 0644 {} + \)
chown root:root "$H6AI" "$H6AI/public" "$H6AI/private" "$H6AI/private/conf"
chmod 0755 "$H6AI" "$H6AI/public" "$H6AI/private" "$H6AI/private/conf"
for dir in "$H6AI/public/cache" "$H6AI/private/cache" "$H6AI/private/data" /var/lib/php/sessions; do
    mkdir -p "$dir"
    chown -R "$WEB_USER:$WEB_USER" "$dir"
done
chmod 0755 "$H6AI/public/cache"
chmod 0700 "$H6AI/private/cache" "$H6AI/private/data" /var/lib/php/sessions
# stale compiled config copies from a previous version
rm -f "$H6AI"/private/cache/json-*.php

# --- sample data --------------------------------------------------------------------------------
if [ "${H6AI_SEED:-1}" = "1" ]; then
    "$HERE/seed.sh"
fi

# Large performance test file, generated in the background (takes a while for several GiB).
if [ "${H6AI_SEED:-1}" = "1" ] && [ "${H6AI_SEED_BIG_GB:-0}" != "0" ] && [ -f "$WWW/.h6ai-seeded" ]; then
    "$HERE/bigfile.sh" "$WWW/big" "$H6AI_SEED_BIG_GB" &
fi

if [ -z "${H6AI_PASSHASH:-}" ] && [ -z "${H5AI_PASSHASH:-}" ]; then
    echo "[init] H6AI_PASSHASH not set - bootstrap admin login is disabled until users exist"
fi

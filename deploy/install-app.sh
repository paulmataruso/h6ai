#!/bin/sh
# Installs or upgrades the h6ai application into a web root. Used by the Docker image on every
# start (docker/init.sh) and by the native installer (install.sh).
#
#   install-app.sh SOURCE TARGET USER [GROUP]
#
#   SOURCE  a built _h6ai folder (build/_h6ai, or _h6ai from a release bundle)
#   TARGET  <web root>/_h6ai
#   USER    the account PHP-FPM runs as. It owns the writable folders, nothing else.
#
# Only code is replaced. Local options (private/conf/options.local.json), data (users, settings,
# activity log), caches and a custom public/ext folder are kept.
set -eu

SRC=${1:?source _h6ai folder}
H6AI=${2:?target _h6ai folder}
WEB_USER=${3:?php-fpm user}
WEB_GROUP=${4:-$WEB_USER}

[ -f "$SRC/public/index.php" ] || { echo "install-app: $SRC is not a built _h6ai folder" >&2; exit 1; }

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
    chown root:root "$H6AI/private/conf/$(basename "$f")"
    chmod 0644 "$H6AI/private/conf/$(basename "$f")"
done
for f in "$SRC"/*.md "$SRC"/LICENSE; do
    [ -f "$f" ] && cp "$f" "$H6AI/"
done

# Code is root owned and read-only for PHP. Only these folders are writable by PHP:
#   public/cache  - thumbnails (served statically by nginx)
#   private/cache - rate limiter, command detection, folder size, compiled config caches
#   private/data  - users, roles, permissions, settings, activity log
set -- "$H6AI/public/js" "$H6AI/public/css" "$H6AI/public/images" "$H6AI/public/index.php" \
       "$H6AI/private/php" "$H6AI/private/bin" "$H6AI/private/conf/l10n"
find "$@" \( -type d -exec chmod 0755 {} + \) -o \( -type f -exec chmod 0644 {} + \)
chown -R root:root "$@"
chown root:root "$H6AI" "$H6AI/public" "$H6AI/private" "$H6AI/private/conf"
chmod 0755 "$H6AI" "$H6AI/public" "$H6AI/private" "$H6AI/private/conf"
for dir in "$H6AI/public/cache" "$H6AI/private/cache" "$H6AI/private/data"; do
    mkdir -p "$dir"
    chown -R "$WEB_USER:$WEB_GROUP" "$dir"
done
chmod 0755 "$H6AI/public/cache"
chmod 0700 "$H6AI/private/cache" "$H6AI/private/data"
# stale compiled config copies from a previous version
rm -f "$H6AI"/private/cache/json-*.php

sed -n "s/.*H6AI_VERSION', '\([^']*\)'.*/\1/p" "$H6AI/public/index.php"

#!/bin/sh
# Runs php-fpm (daemonised) and nginx (foreground, PID 1) in one container.
set -eu

/usr/local/share/h6ai/init.sh

php-fpm --test
nginx -t -q

php-fpm --daemonize
echo "[entrypoint] php-fpm started"

# The search indexer (docs/SEARCH.md) keeps the file name index current, at the lowest CPU and
# disk priority. It idles while search is off. H6AI_SEARCH_INDEXER=0: no daemon (web requests
# then do the index work in slices). It restarts itself after an update or a crash.
if [ "${H6AI_SEARCH_INDEXER:-1}" != "0" ]; then
    (
        set -- nice -n 19
        command -v ionice >/dev/null 2>&1 && set -- "$@" ionice -c 3
        while :; do
            "$@" php /srv/www/_h6ai/private/bin/h6ai-index.php daemon || true
            sleep 10
        done
    ) &
    echo "[entrypoint] search indexer started"
fi

echo "[entrypoint] starting nginx"
exec nginx -g 'daemon off;'

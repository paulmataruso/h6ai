#!/bin/sh
# Runs php-fpm (daemonised) and nginx (foreground, PID 1) in one container.
set -eu

/usr/local/share/h6ai/init.sh

php-fpm --test
nginx -t -q

php-fpm --daemonize
echo "[entrypoint] php-fpm started, starting nginx"
exec nginx -g 'daemon off;'

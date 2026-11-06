#!/bin/sh
# Search index tests (test-php/search.test.php) in the PHP image, as a non-root user (so that
# unreadable files really are unreadable). SEED=n repeats a run, ROUNDS=n changes its length.
#
#   sh test-php/run.sh
#   PHP_IMAGE=php:8.2-cli sh test-php/run.sh
set -eu
cd "$(dirname "$0")/.."
IMAGE=${PHP_IMAGE:-php:8.3.36-fpm-alpine}
# never root: root reads everything, and unreadable files are part of the test
uid=$(id -u); [ "$uid" = 0 ] && uid=1000
exec docker run --rm --user "$uid:$uid" -e SEED="${SEED:-}" -e ROUNDS="${ROUNDS:-}" -e DEBUG="${DEBUG:-}" \
    -v "$PWD/src:/src:ro" -v "$PWD/test-php:/test:ro" "$IMAGE" php -d memory_limit=512M /test/search.test.php /src/_h6ai

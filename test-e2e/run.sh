#!/bin/sh
# Browser end-to-end test (Playwright in Docker) against the running compose service.
# Screenshots land in test-e2e/shots/. Leaves no users/rules behind.
#   test-e2e/run.sh                       # http://172.16.1.67:8687
#   H6AI_URL=http://host:port test-e2e/run.sh
set -eu
cd "$(dirname "$0")"
# the development overlay (sample tree, bootstrap login) is what the tests expect
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml:compose.dev.yaml}"
URL=${H6AI_URL:-http://${H6AI_BIND:-172.16.1.67}:${H6AI_PORT:-8687}}
IMAGE=mcr.microsoft.com/playwright:v1.49.1-noble
mkdir -p shots && chmod 777 shots
# the bootstrap admin login only works while no users exist
(cd .. && docker compose exec -T h6ai sh -c 'rm -f /srv/www/_h6ai/private/cache/ratelimit-*.json') || true
docker run --rm -e H6AI_URL="$URL" -v "$PWD":/w -w /w "$IMAGE" sh -c \
    '[ -d node_modules/playwright ] || npm i --no-save --silent playwright@1.49.1 >/dev/null 2>&1; node e2e.js'

#!/bin/sh
# Runs the integration / security regression suite against the compose service.
#
#   test-integration/run.sh                 # uses H6AI_URL or http://$H6AI_BIND:$H6AI_PORT
#   H6AI_URL=http://127.0.0.1:8687 test-integration/run.sh
#
# Before running it clears the login rate-limiter state inside the container (the last test file
# deliberately locks the client out), and afterwards checks that no generated thumbnail is executable.
set -eu
cd "$(dirname "$0")/.."

# the development overlay (sample tree, bootstrap login) is what the tests expect
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml:compose.dev.yaml}"
URL=${H6AI_URL:-http://${H6AI_BIND:-172.16.1.67}:${H6AI_PORT:-8687}}
SERVICE=${H6AI_SERVICE:-h6ai}
H6AI_DIR=/srv/www/_h6ai

running() { [ -n "$(docker compose ps --status running -q "$SERVICE" 2>/dev/null)" ]; }

if running; then
    echo "[run] resetting login rate limits in service '$SERVICE'"
    docker compose exec -T "$SERVICE" sh -c "rm -f $H6AI_DIR/private/cache/ratelimit-*.json"
else
    echo "[run] service '$SERVICE' not running via compose - rate limits not reset"
fi

echo "[run] testing $URL"
status=0
H6AI_URL=$URL node --test --test-concurrency=1 "$@" test-integration/ || status=$?

if running; then
    exe=$(docker compose exec -T "$SERVICE" sh -c "find $H6AI_DIR/public/cache -type f -perm /111" || true)
    if [ -n "$exe" ]; then
        echo "[run] FAIL: executable files in the public cache (S15):"
        echo "$exe"
        status=1
    else
        echo "[run] ok: no executable files in the public cache (S15)"
    fi
    # leave the client unlocked for manual testing
    docker compose exec -T "$SERVICE" sh -c "rm -f $H6AI_DIR/private/cache/ratelimit-*.json"
fi

exit $status

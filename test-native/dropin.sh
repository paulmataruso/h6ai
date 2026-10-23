#!/bin/sh
# Drop-in install on a stock Debian nginx + PHP-FPM, as docs/install/dropin.md describes it:
#   * _h6ai from h6ai-<version>-dropin.zip unpacked into the web root (nothing else in there)
#   * the shared files in /srv/files, outside the web root
#   * one line in the server block: error_page 403 404 = /_h6ai/public/index.php;
# Then: the first run without a shell, the drop-in checks, and the full integration suite twice,
# with PHP sending the files and with nginx sending them (X-Accel-Redirect).
#
#   test-native/dropin.sh            logs: test-native/logs/dropin*.log
#   KEEP=1 keeps the container (h6ai-native-dropin, http://127.0.0.1:18897), E2E=0 skips the
#   browser tests
# shellcheck disable=SC2016 # single-quoted commands are expanded inside the container
set -eu
cd "$(dirname "$0")/.."

PORT=18897
c=h6ai-native-dropin
log=test-native/logs/dropin.log
mkdir -p test-native/logs
: > "$log"
status=0
fail() { status=1; echo "[dropin] FAIL $1" | tee -a "$log"; }
x() { docker exec "$c" sh -c "$1" >> "$log" 2>&1; }
check() {
    rc=0
    H6AI_URL="http://127.0.0.1:$PORT" node test-native/dropin-check.mjs "$@" > test-native/logs/dropin-check.out 2>&1 || rc=$?
    tee -a "$log" < test-native/logs/dropin-check.out
    return "$rc"
}
suite() { # name
    x 'rm -f /var/www/html/_h6ai/private/cache/ratelimit-*'
    if H6AI_URL="http://127.0.0.1:$PORT" node --test --test-concurrency=1 test-integration/*.test.mjs > "test-native/logs/dropin-$1.suite.log" 2>&1; then
        echo "[dropin] suite ($1): $(grep -E '^# (pass|skipped)' "test-native/logs/dropin-$1.suite.log" | tr '\n' ' ')"
    else
        fail "suite ($1): $(grep -E '^# (pass|fail)' "test-native/logs/dropin-$1.suite.log" | tr '\n' ' ')"
        grep -E '^not ok' "test-native/logs/dropin-$1.suite.log" | sed 's/^/[dropin]   /' || true
    fi
    grep -E '# SKIP' "test-native/logs/dropin-$1.suite.log" | sed 's/^/[dropin]   /' || true
}

VERSION=$(node -p 'require("./package.json").version')
[ "${SKIP_BUILD:-0}" = 1 ] && [ -f "build/h6ai-$VERSION-dropin.zip" ] || npm run -s release >/dev/null
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$c" >/dev/null 2>&1 || true' EXIT

docker rm -f "$c" >/dev/null 2>&1 || true
docker run -d --name "$c" -p "127.0.0.1:$PORT:80" debian:12 sleep infinity >/dev/null
docker cp "build/h6ai-$VERSION-dropin.zip" "$c:/tmp/h6ai.zip"
docker cp docker "$c:/tmp/seed"

echo "[dropin] stock nginx + PHP-FPM; _h6ai in /var/www/html, files in /srv/files"
x 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends \
       nginx php8.2-fpm php8.2-gd php8.2-mbstring unzip curl ffmpeg ghostscript zip >/dev/null' || fail "packages"
# the usual site, plus the one h6ai line
x 'cat > /etc/nginx/sites-available/default <<"EOF"
server {
    listen 80 default_server;
    root /var/www/html;
    index index.html index.htm index.php;
    server_name _;
    location / {
        try_files $uri $uri/ =404;
    }
    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    }
    error_page 403 404 = /_h6ai/public/index.php;
}
EOF
cd /var/www/html && rm -f index.nginx-debian.html && unzip -q /tmp/h6ai.zip
chown -R www-data: _h6ai/private/data _h6ai/private/cache _h6ai/public/cache
mkdir -p /srv/files
H6AI_WEBROOT=/srv/files H6AI_OUTSIDE=/srv/outside sh /tmp/seed/seed.sh >/dev/null
/etc/init.d/php8.2-fpm start && /etc/init.d/nginx start' || fail "drop-in setup"

echo "[dropin] first run without a shell"
check firstrun || fail "first run"
# the setup file from the first run, plus the options the suite expects (compose.dev.yaml)
node -e '
    const fs = require("fs");
    const file = fs.readFileSync("test-native/logs/dropin-setup.php", "utf8");
    const guard = file.slice(0, file.indexOf("\n") + 1);
    const local = Object.assign(JSON.parse(file.slice(guard.length)),
        JSON.parse(fs.readFileSync("docker/options.local.json", "utf8")),
        {passhash: process.argv[1]});
    fs.writeFileSync("test-native/logs/dropin-options.local.php", guard + JSON.stringify(local, null, 4) + "\n");' \
    '$2y$10$3oSPC0TARrMhHAVbLgW5O.IDVLaWCC4eOwApT63oHr.wQ3BCanofi'
docker cp test-native/logs/dropin-options.local.php "$c:/var/www/html/_h6ai/private/conf/options.local.php"
x 'chmod 0644 /var/www/html/_h6ai/private/conf/options.local.php'
check checks || fail "drop-in checks"

echo "[dropin] integration suite, PHP sends the files"
suite php
x 'rm -f /var/www/html/_h6ai/private/cache/ratelimit-*'
# a PHP file big enough for nginx: still sent as data, never run by the server's PHP location
x 'php -r '"'"'file_put_contents("/srv/files/docs/big-script.php", "<?php echo \"RAN\"; ?>\n" . str_repeat("x", 5 << 20));'"'"
check fast || fail "fast downloads"
echo "[dropin] integration suite, nginx sends the files"
suite nginx

if [ "${E2E:-1}" = 1 ]; then
    echo "[dropin] browser tests (Playwright)"
    x 'rm -f /var/www/html/_h6ai/private/cache/ratelimit-*'
    e2e=$(cd test-e2e && mkdir -p shots && docker run --rm --network host -e H6AI_URL="http://127.0.0.1:$PORT" -v "$PWD":/w -w /w \
        mcr.microsoft.com/playwright:v1.49.1-noble sh -c '[ -d node_modules/playwright ] || npm i --no-save --silent playwright@1.49.1 >/dev/null 2>&1; node e2e.js' 2>&1 || true)
    echo "$e2e" >> "$log"
    echo "[dropin] browser: $(echo "$e2e" | grep -c '^ok') ok, $(echo "$e2e" | grep -c '^FAIL') failed"
    problems=$(echo "$e2e" | grep -E '^FAIL|^\[[a-z]+\] (console|pageerror|XSS|404)' || true)
    if [ -n "$problems" ]; then
        echo "$problems" | sed 's/^/[dropin]   /'
        fail "browser tests"
    fi
fi

[ "$status" = 0 ] && echo "[dropin] PASS" || echo "[dropin] see $log"
exit "$status"

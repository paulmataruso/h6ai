#!/bin/sh
# Drop-in on a customised server block (test-native/dropin-custom.conf), as the drop-in guide's
# "Coming from h5ai" section converts one: nginx.org's mainline nginx with TLS, HTTP/2, HTTP/3 and
# 0-RTT, basic auth, a caching rule for static files, several logs, rate limits; Debian's PHP 8.2.
#   A  first run, drop-in checks (internal location), the integration suite with PHP and with nginx
#      sending the files
#   B  h6ai's headers on big files, the visitor's URL in the logs, 425 for API requests in 0-RTT
#   C  the admin page in Chromium over HTTP/3 behind basic auth: every check green, fast downloads on
#   D  without the internal location: the admin page flags the big-file headers and the open link
#   E  without the PHP location's "not found" check: the admin page flags .php
#
#   test-native/dropin-custom.sh      logs: test-native/logs/dropin-custom*.log
#   KEEP=1 keeps the container (h6ai-dropin-custom)
# shellcheck disable=SC2016 # single-quoted commands are expanded inside the container
set -eu
cd "$(dirname "$0")/.."

c=h6ai-dropin-custom
log=test-native/logs/dropin-custom.log
mkdir -p test-native/logs
: > "$log"
status=0
fail() { status=1; echo "[custom] FAIL $1" | tee -a "$log"; }
x() { docker exec "$c" sh -c "$1" >> "$log" 2>&1; }
q() { docker exec "$c" sh -c "$1"; }
# clients run in the container's network and reach nginx on 443, as visitors do
nodec() {
    docker run --rm --network "container:$c" -v "$PWD":/repo -w /repo -e H6AI_URL=https://127.0.0.1 \
        -e NODE_TLS_REJECT_UNAUTHORIZED=0 -e NODE_NO_WARNINGS=1 -e DROPIN_INTERNAL=1 node:22 "$@"
}
check() {
    rc=0
    nodec node test-native/dropin-check.mjs "$@" > test-native/logs/dropin-custom-check.out 2>&1 || rc=$?
    tee -a "$log" < test-native/logs/dropin-custom-check.out
    return "$rc"
}
suite() { # name
    x 'rm -f /var/www/html/_h6ai/private/cache/ratelimit-*'
    if nodec node --test --test-concurrency=1 test-integration/*.test.mjs > "test-native/logs/dropin-custom-$1.suite.log" 2>&1; then
        echo "[custom] suite ($1): $(grep -E '^# (pass|skipped)' "test-native/logs/dropin-custom-$1.suite.log" | tr '\n' ' ')"
    else
        fail "suite ($1): $(grep -E '^# (pass|fail)' "test-native/logs/dropin-custom-$1.suite.log" | tr '\n' ' ')"
        grep -E '^not ok' "test-native/logs/dropin-custom-$1.suite.log" | sed 's/^/[custom]   /' || true
    fi
}
site() { # variant: base, basic, nointernal, nophpcheck
    case $1 in
        base) cmd='cat' ;;
        basic) cmd='sed -E "s/^([[:space:]]*)#(auth_basic.*# @basic)$/\1\2/"' ;;
        nointernal) cmd='grep -v "# @internal"' ;;
        nophpcheck) cmd='grep -v "# @php-check"' ;;
    esac
    x "$cmd < /tmp/site.conf > /etc/nginx/conf.d/files.conf && nginx -t && nginx -s reload && sleep 1"
}
admin() { # name, then NAME=value settings for test-native/dropin-admin.cjs
    name=$1
    shift
    x 'rm -f /var/www/html/_h6ai/private/cache/ratelimit-*'
    # each NAME=value becomes "-e" "NAME=value", values with spaces and newlines intact
    n=$#
    while [ "$n" -gt 0 ]; do
        set -- "$@" -e "$1"
        shift
        n=$((n - 1))
    done
    out=$(docker run --rm --network "container:$c" -v "$PWD":/repo -w /repo/test-e2e -e H6AI_URL=https://127.0.0.1 "$@" \
        mcr.microsoft.com/playwright:v1.49.1-noble sh -c '[ -d node_modules/playwright ] || npm i --no-save --silent playwright@1.49.1 >/dev/null 2>&1
            PLAYWRIGHT=/repo/test-e2e/node_modules/playwright node /repo/test-native/dropin-admin.cjs' 2>&1) || fail "admin page: $name"
    echo "$out" | tee -a "$log"
}

VERSION=$(node -p 'require("./package.json").version')
[ "${SKIP_BUILD:-0}" = 1 ] && [ -f "build/h6ai-$VERSION-dropin.zip" ] || npm run -s release >/dev/null
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$c" >/dev/null 2>&1 || true' EXIT

docker rm -f "$c" >/dev/null 2>&1 || true
docker run -d --name "$c" debian:12 sleep infinity >/dev/null
docker cp "build/h6ai-$VERSION-dropin.zip" "$c:/tmp/h6ai.zip"
docker cp docker "$c:/tmp/seed"
docker cp test-native/dropin-custom.conf "$c:/tmp/site.conf"

echo "[custom] nginx.org mainline + Debian PHP 8.2, TLS at the Let's Encrypt paths, the customised server block"
x 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends \
       curl gnupg2 ca-certificates openssl debian-archive-keyring >/dev/null
curl -fsSL https://nginx.org/keys/nginx_signing.key | gpg --dearmor > /usr/share/keyrings/nginx-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/mainline/debian bookworm nginx" \
    > /etc/apt/sources.list.d/nginx.list
apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    nginx php8.2-fpm php8.2-gd php8.2-mbstring unzip ffmpeg ghostscript zip >/dev/null' || fail "packages"
x 'sed -i "s/^user .*/user www-data;/" /etc/nginx/nginx.conf && sed -i "1i thread_pool files_pool threads=8;" /etc/nginx/nginx.conf
rm -f /etc/nginx/conf.d/default.conf
cat > /etc/nginx/conf.d/00-http.conf <<"EOF"
log_format download '"'"'$time_iso8601 $status $body_bytes_sent request_uri=$request_uri'"'"';
log_format goaccess '"'"'$remote_addr [$time_local] "$request" $status $body_bytes_sent'"'"';
map $request_uri $log_download { default 0; ~*\.(iso|zip|mp4|mkv|bin|pdf|txt)$ 1; }
limit_conn_zone $binary_remote_addr zone=conn_limit:10m;
limit_req_zone $binary_remote_addr zone=download_limit:10m rate=20r/s;
EOF
L=/etc/letsencrypt && mkdir -p $L/live/files.example.com
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj /CN=files.example.com \
    -addext "subjectAltName=DNS:files.example.com,IP:127.0.0.1" \
    -keyout $L/live/files.example.com/privkey.pem -out $L/live/files.example.com/fullchain.pem
cat > $L/options-ssl-nginx.conf <<"EOF"
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
EOF
mkdir -p /var/www/errors && for n in 401 429 503; do echo "custom $n page" > /var/www/errors/$n.html; done
echo "basic:{PLAIN}basic-pass" > /etc/nginx/.htpasswd
cp /tmp/site.conf /etc/nginx/conf.d/files.conf
mkdir -p /var/www/html && cd /var/www/html && unzip -q /tmp/h6ai.zip
chown -R www-data: _h6ai/private/data _h6ai/private/cache _h6ai/public/cache
mkdir -p /srv/files && H6AI_WEBROOT=/srv/files H6AI_OUTSIDE=/srv/outside sh /tmp/seed/seed.sh >/dev/null
/etc/init.d/php8.2-fpm start && nginx && nginx -t' || fail "setup"

echo "[custom] A: first run, drop-in checks, integration suite over HTTPS"
check firstrun || fail "first run"
node -e '
    const fs = require("fs");
    const file = fs.readFileSync("test-native/logs/dropin-setup.php", "utf8");
    const guard = file.slice(0, file.indexOf("\n") + 1);
    const local = Object.assign(JSON.parse(file.slice(guard.length)),
        JSON.parse(fs.readFileSync("docker/options.local.json", "utf8")),
        {passhash: process.argv[1]});
    fs.writeFileSync("test-native/logs/dropin-custom-options.local.php", guard + JSON.stringify(local, null, 4) + "\n");' \
    '$2y$10$3oSPC0TARrMhHAVbLgW5O.IDVLaWCC4eOwApT63oHr.wQ3BCanofi'
docker cp test-native/logs/dropin-custom-options.local.php "$c:/var/www/html/_h6ai/private/conf/options.local.php"
x 'chmod 0644 /var/www/html/_h6ai/private/conf/options.local.php'
check checks || fail "drop-in checks"
suite php
x 'rm -f /var/www/html/_h6ai/private/cache/ratelimit-*'
x 'php -r '"'"'file_put_contents("/srv/files/docs/big-script.php", "<?php echo \"RAN\"; ?>\n" . str_repeat("x", 5 << 20));'"'"
check fast || fail "fast downloads"
suite nginx

echo "[custom] B: big-file headers, logs, 0-RTT"
x 'head -c 6291456 /dev/urandom > /srv/files/videos/big.mp4; : > /var/log/nginx/files.access.log; : > /var/log/nginx/files.download.log'
cc=$(q "curl -ks -o /dev/null -D - https://127.0.0.1/videos/big.mp4" | tr -d '\r' | grep -i '^cache-control:' | tr '\n' ' ')
case $cc in
    *"public, no-cache"*) case $cc in *max-age*) fail "big .mp4 got the caching rule's headers: $cc" ;; *) echo "[custom]   ok big .mp4 keeps h6ai's $cc" ;; esac ;;
    *) fail "big .mp4: $cc" ;;
esac
sleep 1
if q 'grep -q "\"GET /videos/big.mp4 HTTP/[0-9.]*\" 200 6291456" /var/log/nginx/files.access.log && grep -q "request_uri=/videos/big.mp4" /var/log/nginx/files.download.log'; then
    echo "[custom]   ok the access and download logs show the visitor's URL"
else
    fail "logs: $(q 'tail -n 2 /var/log/nginx/files.access.log /var/log/nginx/files.download.log' | tr '\n' ' ')"
fi
x 'rm -f /var/www/html/_h6ai/private/cache/ratelimit-*'
early=$(q 'cd /tmp && printf "GET / HTTP/1.1\r\nHost: files.example.com\r\nConnection: close\r\n\r\n" > get.txt
    openssl s_client -connect 127.0.0.1:443 -servername files.example.com -tls1_3 -sess_out sess.pem -ign_eof < get.txt > /dev/null 2>&1
    body="{\"action\":\"login\",\"user\":\"admin\",\"pass\":\"admin-test\"}"
    printf "POST /_h6ai/public/index.php HTTP/1.1\r\nHost: files.example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" \
        ${#body} "$body" > early.txt
    openssl s_client -connect 127.0.0.1:443 -servername files.example.com -tls1_3 -sess_in sess.pem -early_data early.txt -ign_eof < /dev/null 2>&1' \
    | tr -d '\r' | grep -E '^HTTP/|^Early data was' | tr '\n' ' ')
case $early in
    *"Early data was accepted"*"HTTP/1.1 425"*|*"HTTP/1.1 425"*"Early data was accepted"*) echo "[custom]   ok a login sent as TLS early data gets 425 ($early)" ;;
    *) fail "0-RTT login: $early" ;;
esac

echo "[custom] C: the admin page over HTTP/3 behind basic auth"
site basic
spki=$(q 'openssl x509 -in /etc/letsencrypt/live/files.example.com/fullchain.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64')
admin "basic auth, HTTP/3" BASIC=basic:basic-pass QUIC="$spki" SHOT=/repo/test-native/logs/dropin-custom-admin.png EXPECT='{
    "Routing": "passed yes", "Private data": "passed protected", "Private cache": "passed not listed",
    "Fast downloads": "passed nginx", "Big files": "passed as h6ai sent them", "Secret links": "passed internal",
    "File types": "passed all", "Old h5ai folder": "failed delete _h5ai"}' \
    NO_BANNER='["hand unknown paths", "replaces h6ai", "answers requests for", "sends .* without asking"]'
nosniff=$(q "curl -ks -u basic:basic-pass -o /dev/null -D - https://127.0.0.1/big/big.bin" | tr -d '\r' | grep -ic '^x-content-type-options' || true)
if [ "$nosniff" = 0 ]; then
    echo "[custom]   ok fast downloads stayed on: nginx sends big.bin"
else
    fail "after the admin page, PHP sends big.bin"
fi

echo "[custom] D: without the internal location"
site nointernal
admin "no internal location" SHOT=/repo/test-native/logs/dropin-custom-admin-nointernal.png EXPECT='{"Big files": "failed headers changed: .zip, .gz, .mp4", "Secret links": "pending reachable", "File types": "passed all"}' \
    BANNERS='["replaces h6ai.s headers on big"]'

echo "[custom] E: without the PHP location's not-found check"
site nophpcheck
admin "no PHP check" EXPECT='{"File types": "failed not .php"}' BANNERS='["answers requests for \\.php files itself"]'

[ "$status" = 0 ] && echo "[custom] PASS" || echo "[custom] see $log"
exit "$status"

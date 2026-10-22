#!/bin/sh
# Native installer under a real systemd (PID 1), the way it runs on a server: services enabled and
# started by the installer, a generated admin password, a reboot, an uninstall.
#
#   test-native/systemd.sh [ubuntu:24.04|debian:12|...]
#
# Needs privileged containers (systemd manages cgroups). Log: test-native/logs/systemd.log
# shellcheck disable=SC2016 # single-quoted commands are expanded inside the container
set -eu
cd "$(dirname "$0")/.."

BASE=${1:-ubuntu:24.04}
PORT=18890
c=h6ai-native-systemd
log=test-native/logs/systemd.log
mkdir -p test-native/logs
: > "$log"
status=0
fail() { status=1; echo "[systemd] FAIL $1" | tee -a "$log"; }
x() { docker exec "$c" sh -c "$1" >> "$log" 2>&1; }

VERSION=$(node -p 'require("./package.json").version')
[ "${SKIP_BUILD:-0}" = 1 ] && [ -f "build/h6ai-$VERSION.tar.gz" ] || npm run -s release >/dev/null
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; [ "${KEEP:-0}" = 1 ] || docker rm -f "$c" >/dev/null 2>&1 || true' EXIT
tar -xzf "build/h6ai-$VERSION.tar.gz" -C "$WORK"

echo "[systemd] image with systemd from $BASE"
docker build -q -t "h6ai-systemd-test:$(echo "$BASE" | tr ':/' '--')" - >/dev/null <<EOF
FROM $BASE
RUN if command -v apt-get >/dev/null; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv >/dev/null; \
    else dnf -y -q install systemd >/dev/null; fi
CMD ["/sbin/init"]
EOF
docker rm -f "$c" >/dev/null 2>&1 || true
docker run -d --name "$c" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    --tmpfs /run --tmpfs /run/lock -p "127.0.0.1:$PORT:80" -v "$WORK/h6ai-$VERSION:/opt/h6ai-bundle:ro" \
    "h6ai-systemd-test:$(echo "$BASE" | tr ':/' '--')" >/dev/null
for _ in $(seq 30); do
    docker exec "$c" systemctl is-system-running 2>/dev/null | grep -Eq 'running|degraded' && break
    sleep 1
done

echo "[systemd] install.sh --yes"
x '/opt/h6ai-bundle/install.sh --yes --root /srv/files' || fail "install.sh"
grep -q "check: index 200, private files 403" "$log" || fail "installer self-check"
password=$(sed -n 's/^  Login: *admin \/ \(.*\)$/\1/p' "$log")
[ -n "$password" ] || fail "no generated admin password in the summary"
x '. /etc/h6ai/install.conf; systemctl is-enabled nginx "$FPM_SERVICE" && systemctl is-active nginx "$FPM_SERVICE"' \
    || fail "services not enabled and active"

login() {
    H6AI_URL="http://127.0.0.1:$PORT" node -e '
        import("./test-integration/lib.mjs").then(async ({login}) => {
            const {json} = await login("admin", process.argv[1]);
            process.exit(json && json.asAdmin === true ? 0 : 1);
        });' "$1"
}
login "$password" || fail "login with the generated password"

echo "[systemd] reboot"
docker restart "$c" >/dev/null
for _ in $(seq 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
    [ "$code" = 200 ] && break
    sleep 1
done
[ "$code" = 200 ] || fail "index after reboot: $code"
login "$password" || fail "login after reboot"

echo "[systemd] uninstall --purge"
x '/opt/h6ai-bundle/install.sh --uninstall --purge' || fail "uninstall"
x '! [ -e /srv/files/_h6ai ] && nginx -t && systemctl is-active nginx' || fail "state after uninstall"
body=$(curl -s "http://127.0.0.1:$PORT/" || true)
case $body in *"Welcome to nginx"*) ;; *) fail "the distribution's default site is not back" ;; esac

[ "$status" = 0 ] && echo "[systemd] PASS" || echo "[systemd] see $log"
exit "$status"

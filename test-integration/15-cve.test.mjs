// CVE hardening.
//
// CVE-2026-109618 (PHP, RCE via out-of-memory longjmp corruption, fixed in 8.2.35 / 8.3.36 /
// 8.4.27 / 8.5.12): the image pins a fixed PHP and nginx keeps the main trigger (multipart body
// parsing) and oversized bodies away from PHP entirely.
//
// CVE-2026-10961 (Chrome for iOS < 149.0.7827.53, sandbox escape via a crafted HTML page): h6ai
// can't patch browsers, but user supplied active documents are served script-free (CSP sandbox).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request, get, ORIGIN, adminSession, adminOp, getSetup, ACTIVE_DOCS} from './lib.mjs';

const SANDBOX = /(^|;)\s*sandbox\s*(;|$)/;

const versionAtLeast = (version, min) => {
    const a = version.split(/[.+-]/).map(Number);
    const b = min.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] || 0) !== b[i]) {
            return (a[i] || 0) > b[i];
        }
    }
    return true;
};
const FIXED = {'8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27', '8.5': '8.5.12'};

test('CVE-2026-109618: multipart bodies are rejected by nginx (415) on every path', async () => {
    const boundary = '----h6ai';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\nget\r\n--${boundary}--\r\n`;
    for (const path of ['/', '/docs/', '/_h6ai/public/index.php', '/_h6ai/public/']) {
        const res = await request('POST', path, {
            headers: {'Content-Type': `multipart/form-data; boundary=${boundary}`, Origin: ORIGIN},
            body
        });
        assert.equal(res.status, 415, `${path}: ${res.status}`);
        assert.doesNotMatch(res.text, /"err"/, 'answered by nginx, not PHP');
    }
    // also with odd casing / leading whitespace
    const res = await request('POST', '/', {headers: {'Content-Type': ' Multipart/Mixed; boundary=x'}, body: 'x'});
    assert.equal(res.status, 415);
});

test('CVE-2026-109618: methods other than GET/HEAD/POST are refused (405)', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        const res = await request(method, '/', {headers: {'Content-Type': 'application/json'}, body: '{}'});
        assert.equal(res.status, 405, `${method}: ${res.status}`);
    }
});

test('CVE-2026-109618: request bodies over 1 MiB are refused (413)', async () => {
    const body = Buffer.alloc(1024 * 1024 + 4096, 0x20);
    const res = await request('POST', '/', {headers: {'Content-Type': 'application/json', Origin: ORIGIN}, body});
    assert.equal(res.status, 413);
});

test('CVE-2026-109618: PHP runs a fixed release (admin setup reports it)', async () => {
    const admin = await adminSession();
    const {setup} = await getSetup(admin.jar);
    const branch = setup.PHP_VERSION.split('.').slice(0, 2).join('.');
    const min = FIXED[branch];
    assert.ok(min || versionAtLeast(setup.PHP_VERSION, '8.6.0'), `unexpected PHP branch ${setup.PHP_VERSION}`);
    if (min && !versionAtLeast(setup.PHP_VERSION, min)) {
        // distribution packages (Ubuntu) backport the fix without changing the version
        assert.equal(setup.PHP_CVE_2026_109618_FIX, 'backport', `PHP ${setup.PHP_VERSION} < ${min} and no backport found`);
    } else {
        assert.equal(setup.PHP_CVE_2026_109618_FIX, 'version');
    }
    assert.equal(setup.PHP_CVE_2026_109618_FIXED, true, 'setup.PHP_CVE_2026_109618_FIXED');
});

test('CVE-2026-109618: guests are not told the PHP version', async () => {
    const {setup} = await getSetup(null);
    assert.equal(setup.PHP_VERSION, undefined);
    assert.equal(setup.PHP_CVE_2026_109618_FIXED, undefined);
});

test('CVE-2026-10961: active documents in the share are sandboxed (no script)', async () => {
    for (const path of ACTIVE_DOCS) {
        const res = await get(path);
        assert.equal(res.status, 200, path);
        const csp = res.headers['content-security-policy'] || '';
        assert.match(csp, SANDBOX, `${path}: CSP sandbox missing (${csp})`);
        assert.match(csp, /default-src 'none'/, path);
        assert.doesNotMatch(csp, /script-src|allow-scripts|allow-same-origin/, path);
        assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
        assert.ok(res.headers['cache-control'], `${path}: gate Cache-Control still applied`);
    }
});

test('CVE-2026-10961: case variants and unmanaged index.html are sandboxed too', async () => {
    // the unmanaged folder's index.html is served via nginx' index directive
    const site = await get('/site/');
    assert.equal(site.status, 200);
    assert.match(site.text, /Unmanaged site/);
    assert.match(site.headers['content-security-policy'] || '', SANDBOX);
    const direct = await get('/site/index.html');
    assert.match(direct.headers['content-security-policy'] || '', SANDBOX);
});

test('CVE-2026-10961: regular files are not affected', async () => {
    // A drop-in install with fast downloads lets nginx send files from 4 MiB up (X-Accel-Redirect),
    // and nginx keeps only a few of PHP's headers then: no nosniff on big.bin unless the server
    // adds it itself. Active documents and smaller files always go through PHP.
    const {jar, csrf, setup} = await adminSession();
    const settings = setup.IS_DROPIN ? (await adminOp(jar, csrf, 'settings.get')).json.settings : null;
    const nginxSends = settings && settings.dropin.fastDownloads === true;
    for (const path of ['/docs/readme.md', '/docs/notes.txt', '/docs/data.json', '/images/photo.jpg', '/big/big.bin']) {
        const res = await request('HEAD', path);
        assert.equal(res.status, 200, path);
        assert.equal(res.headers['content-security-policy'], undefined, `${path} has a CSP`);
        if (!nginxSends || path !== '/big/big.bin') {
            assert.equal(res.headers['x-content-type-options'], 'nosniff', `${path}: nosniff`);
        }
    }
});

test('CVE-2026-10961: the h6ai UI itself keeps its own (non-sandboxed) CSP', async () => {
    const res = await get('/docs/');
    const csp = res.headers['content-security-policy'] || '';
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(csp, SANDBOX);
});

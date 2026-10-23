// HTTP checks for test-native/dropin.sh, one phase per call:
//   firstrun  fresh install: no login yet, the setup file (password hash + files folder)
//   checks    with the setup file: routing, guarded private data, the X-Accel probe (as every file
//             type the admin page tries, with h6ai's headers), the probe link from outside, setup
//             flags, files reachable only through h6ai (permissions, log, sandbox on direct links)
//             DROPIN_INTERNAL=1: the server block has "location ^~ /_h6ai/private/ { internal; }"
//   fast      switches on nginx sending the files, as the admin page does after its probe
// Logins send Sec-Fetch-Site like a browser: Debian's fastcgi_params replace the Host header
// with $host, which drops the port, so the Origin comparison alone can't match on port 18897.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {request, get, api, apiAs, getSetup, adminOp, okJson} from '../test-integration/lib.mjs';

const BROWSER = {'Sec-Fetch-Site': 'same-origin'};
const PROBE = 'h6ai-xaccel-ok\n';
const ACCEL_EXTS = ['txt', 'bin', 'iso', 'zip', 'gz', 'mp4', 'mkv', 'webm', 'mp3', 'jpg', 'png', 'pdf'];
const ok = msg => console.log(`[dropin]   ok ${msg}`);

const admin = async () => {
    const jar = {};
    const {json} = await apiAs(jar, {action: 'login', user: 'admin', pass: 'admin-test'}, {headers: BROWSER});
    assert.equal(json.asAdmin, true, `admin login: ${JSON.stringify(json)}`);
    const {setup} = await getSetup(jar);
    return {jar, csrf: setup.CSRF, setup};
};
const op = (a, name, payload) => adminOp(a.jar, a.csrf, name, payload, {headers: BROWSER}).then(r => okJson(r, name));

const phases = {
    async firstrun() {
        const index = await get('/');
        assert.equal(index.status, 200, 'the web root (no index file) reaches h6ai through error_page 403');
        const {setup} = await getSetup(null);
        assert.equal(setup.AUTH.loginAvailable, false);
        assert.equal(setup.AUTH.dropin, true);
        ok('fresh drop-in: h6ai answers the web root, no login yet');

        const inside = await api({action: 'passhash', pass: 'setup-password-1', filesFolder: '/var/www/html/files'}, {headers: BROWSER});
        assert.equal(inside.json.folder.insideWebRoot, true, 'a folder in the web root is flagged');
        const made = await api({action: 'passhash', pass: 'setup-password-1', filesFolder: '/srv/files'}, {headers: BROWSER});
        assert.equal(made.res.status, 200, made.res.text);
        assert.deepEqual(made.json.folder, {exists: true, readable: true, insideWebRoot: false});
        assert.match(made.json.file, /^<\?php http_response_code\(404\); exit; \?>\n\{/);
        assert.match(made.json.file, /"filesFolder": "\/srv\/files"/);
        writeFileSync('test-native/logs/dropin-setup.php', made.json.file);
        ok('the setup file holds the password hash and the files folder, behind the guard line');
    },

    async checks() {
        const a = await admin();
        assert.equal(a.setup.IS_DROPIN, true);
        assert.equal(a.setup.ROOT_PATH, '/srv/files');
        assert.equal(a.setup.ROOT_IN_WEBROOT, false);
        assert.equal(a.setup.HAS_POST_PARSING_OFF, true, '_h6ai/public/.user.ini took effect');
        ok('admin setup: drop-in, files folder /srv/files outside the web root, PHP leaves bodies alone');

        const missing = await get('/h6ai-route-check/');
        assert.equal(missing.status, 404);
        assert.equal(missing.headers['x-h6ai-route'], 'not-found', 'unknown paths reach h6ai');
        const canary = await get('/_h6ai/private/conf/canary.php');
        assert.ok(!canary.text.includes('h6ai-canary'), 'guarded files are run, not sent as text');
        const probe = await get('/_h6ai/public/index.php?h6ai-probe=accel');
        assert.equal(probe.text, PROBE, 'nginx follows X-Accel-Redirect through the link');
        for (const ext of ACCEL_EXTS) {
            const typed = await get('/_h6ai/public/index.php?h6ai-probe=accel&ext=' + ext);
            assert.equal(typed.text, PROBE, `.${ext}: nginx doesn't send it`);
            assert.equal(typed.headers['cache-control'], 'no-store', `.${ext}: nginx changed Cache-Control`);
            assert.equal(typed.headers.expires, undefined, `.${ext}: nginx added Expires`);
        }
        const listing = await get('/_h6ai/private/cache/');
        assert.doesNotMatch(listing.text, /x[sp]-[0-9a-f]{40}/, 'the cache folder is not listed');
        ok('routing, guarded private data, X-Accel-Redirect for every file type with h6ai\'s headers, unlisted links');

        const internal = process.env.DROPIN_INTERNAL === '1';
        const {probe: start} = await op(a, 'probe.start');
        assert.match(start.link, /^\/_h6ai\/private\/cache\/xp-[0-9a-f]{40}\/probe\.txt$/);
        const outside = await get(start.link);
        await op(a, 'probe.result');
        assert.equal(outside.text === PROBE, !internal, internal ? 'the probe link answers from outside'
            : 'the probe link is refused from outside, although this server block has no internal location');
        ok(internal ? 'the links h6ai hands big files through are refused from outside (internal location)'
            : 'without the internal location the probe link answers from outside (the admin page advises it)');

        // the files folder is only reachable through h6ai: permissions apply to direct links
        await op(a, 'rule.save', {rule: {path: '/team/', grants: {'*': 'none'}}});
        try {
            assert.equal((await get('/team/notes.txt')).status, 401);
            assert.equal((await get('/team/notes.txt', {headers: {Range: 'bytes=0-3'}})).status, 401);
        } finally {
            await op(a, 'rule.delete', {path: '/team/'});
        }
        assert.equal((await get('/team/notes.txt')).status, 200);
        ok('a folder rule protects direct file links');

        const page = await get('/docs/page.html');
        assert.match(page.headers['content-security-policy'] || '', /(^|;)\s*sandbox\s*(;|$)/);
        ok('HTML files are sandboxed on direct links');
    },

    async fast() {
        const a = await admin();
        await op(a, 'settings.save', {settings: {dropin: {fastDownloads: true}}});
        // big files: nginx sends them, without the nosniff PHP would add
        const big = await request('HEAD', '/big/big.bin');
        assert.equal(big.status, 200);
        assert.equal(big.headers['x-content-type-options'], undefined, 'big.bin still sent by PHP');
        // small ones: PHP, with every header
        assert.equal((await request('HEAD', '/docs/notes.txt')).headers['x-content-type-options'], 'nosniff');
        // a PHP file from the share is data, also when it's big enough for nginx
        const php = await get('/docs/not-executed.php');
        assert.match(php.text, /<\?php/);
        const script = await request('GET', '/docs/big-script.php', {headers: {Range: 'bytes=0-31'}});
        assert.equal(script.status, 206);
        assert.match(script.text, /^<\?php echo "RAN"/, `a big PHP file was run: ${script.text.slice(0, 40)}`);
        const range = await request('GET', '/big/big.bin', {headers: {Range: 'bytes=8-15'}});
        assert.equal(range.status, 206);
        assert.equal(range.body.readBigUInt64BE(0), 8n);
        ok('nginx sends the files (X-Accel-Redirect), Range included');
    }
};

const phase = phases[process.argv[2]];
if (!phase) {
    console.error(`usage: dropin-check.mjs ${Object.keys(phases).join('|')}`);
    process.exit(2);
}
phase().catch(err => {
    console.error(`[dropin]   ${err.message}`);
    process.exit(1);
});

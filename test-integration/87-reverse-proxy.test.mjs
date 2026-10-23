// Reverse proxy settings (admin, System tab). Requests from trusted proxies (IPs / CIDR ranges)
// may set X-Forwarded-For, -Proto and -Host; the public address is used for absolute URLs and
// accepted as login origin. The settings are reset in after().
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {get, api, getSetup, adminSession, adminOp, okJson, parseSetCookie, ADMIN_USER, ADMIN_PASS, BASE} from './lib.mjs';

const PUBLIC = 'https://files.example.com';
let admin = null;
let me = null; // this test client's address as the server sees it

const op = (name, payload, headers) => adminOp(admin.jar, admin.csrf, name, payload, headers === undefined ? undefined : {headers})
    .then(r => okJson(r, name));
const saveProxy = proxy => op('settings.save', {settings: {proxy}});
const seenAs = async headers => (await adminOp(admin.jar, admin.csrf, 'settings.get', {}, {headers}).then(r => okJson(r, 'settings.get'))).request;
const sessionCookie = res => res.setCookies.map(parseSetCookie).find(c => c.value && /sess|h6ai/i.test(c.name));

before(async () => {
    admin = await adminSession();
    me = (await op('settings.get')).request.remoteAddr;
    assert.ok(me, 'settings.get reports the request address');
});

after(async () => {
    if (admin) {
        await saveProxy({publicUrl: '', trusted: []});
    }
});

test('without trusted proxies, X-Forwarded-* headers are ignored', async () => {
    await saveProxy({publicUrl: '', trusted: []});
    const r = await seenAs({'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'evil.example'});
    assert.equal(r.clientIp, me);
    assert.equal(r.fromTrustedProxy, false);
    assert.doesNotMatch(r.publicOrigin, /evil\.example/);
});

test('a trusted proxy\'s X-Forwarded-For becomes the visitor address', async () => {
    await saveProxy({trusted: [me]});
    // right-most entry: what our proxy saw; anything to its left the client may have made up
    let r = await seenAs({'X-Forwarded-For': '198.51.100.1, 203.0.113.7'});
    assert.equal(r.fromTrustedProxy, true);
    assert.equal(r.clientIp, '203.0.113.7');
    // a chain of trusted proxies is skipped
    await saveProxy({trusted: [me, '203.0.113.0/24']});
    r = await seenAs({'X-Forwarded-For': '198.51.100.1, 203.0.113.7'});
    assert.equal(r.clientIp, '198.51.100.1');
    // the activity log records the visitor, not the proxy
    await get('/docs/notes.txt', {headers: {'X-Forwarded-For': '198.51.100.23'}});
    const {entries} = await op('activity.list', {limit: 20});
    assert.ok(entries.some(e => e.path === '/docs/notes.txt' && e.ip === '198.51.100.23'),
        `no entry from 198.51.100.23: ${JSON.stringify(entries.slice(0, 3))}`);
});

test('X-Forwarded-Proto only counts from a trusted proxy once proxies are configured', async () => {
    await saveProxy({trusted: ['192.0.2.1']}); // somebody else
    let res = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {headers: {'X-Forwarded-Proto': 'https'}});
    // over a real HTTPS connection the cookie is Secure whatever the header says
    if (BASE.protocol === 'http:') {
        assert.ok(!sessionCookie(res.res).flags.secure, 'Secure set on a forged X-Forwarded-Proto');
    }
    await saveProxy({trusted: [me]});
    res = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {headers: {'X-Forwarded-Proto': 'https'}});
    assert.ok(sessionCookie(res.res).flags.secure, 'Secure missing behind a trusted HTTPS proxy');
});

test('trusted proxies are validated', async () => {
    for (const bad of ['not-an-ip', '10.0.0.0/33', '300.1.2.3', '::1/129']) {
        const r = await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {proxy: {trusted: [bad]}}});
        assert.equal(r.res.status, 400, `${bad} accepted`);
    }
    const {settings} = await saveProxy({trusted: '10.0.0.0/8\n2001:db8::/32, 172.16.0.5\n10.0.0.0/8'});
    assert.deepEqual(settings.proxy.trusted, ['10.0.0.0/8', '2001:db8::/32', '172.16.0.5']);
});

test('the public address is normalised, used for absolute URLs and accepted as login origin', async () => {
    for (const bad of ['ftp://files.example.com', 'https://files.example.com/sub/', 'https://user@files.example.com', 'https://bad_host']) {
        const r = await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {proxy: {publicUrl: bad}}});
        assert.equal(r.res.status, 400, `${bad} accepted`);
    }
    const {settings} = await saveProxy({publicUrl: 'Files.Example.com/', trusted: []});
    assert.equal(settings.proxy.publicUrl, PUBLIC);

    assert.equal((await getSetup(null)).setup.SITE.publicUrl, PUBLIC);
    const robots = await get('/robots.txt');
    assert.match(robots.text, new RegExp(`Sitemap: ${PUBLIC}/sitemap\\.xml`));
    const sitemap = await get('/sitemap.xml');
    assert.match(sitemap.text, new RegExp(`<loc>${PUBLIC}/docs/</loc>`));

    const viaProxy = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {headers: {Origin: PUBLIC}});
    assert.equal(viaProxy.res.status, 200, viaProxy.res.text);
    const elsewhere = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {headers: {Origin: 'https://evil.example'}});
    assert.equal(elsewhere.res.status, 403);
});

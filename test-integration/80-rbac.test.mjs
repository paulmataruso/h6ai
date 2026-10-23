// Users, roles and per-folder permissions enforced on listings, API features and the nginx file gate.
// Creates user "alice" and rules on /private/ and /site/; everything is removed again in after().
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {
    api, apiAs, get, form, login, getSetup, adminOp, thumb, withJar, errorOf, isTar,
    ADMIN_USER, ADMIN_PASS, PRIVATE_SECRET
} from './lib.mjs';

const ALICE = {name: 'alice', password: 'pw-alice-123', roles: ['user']};
const RULE_PRIVATE = {path: '/private/', grants: {'*': 'none', 'user:alice': 'read'}};
const RULE_SITE = {path: '/site/', grants: {'*': 'none'}};

let admin = null; // {jar, csrf}
let alice = null; // {jar, csrf}

const adminLogin = async () => {
    const {res, json, jar} = await login(ADMIN_USER, ADMIN_PASS);
    assert.equal(res.status, 200, `admin login: ${res.status} ${res.text.slice(0, 200)}`);
    assert.equal(json.asAdmin, true, 'admin login failed (rate limited? see test-integration/README.md)');
    const {setup} = await getSetup(jar);
    assert.ok(setup.CSRF, 'admin session has a CSRF token');
    return {jar, csrf: setup.CSRF};
};

const ok = (r, what) => {
    assert.ok(r.json, `${what}: non-JSON (HTTP ${r.res.status}) ${r.res.text.slice(0, 200)}`);
    assert.equal(r.res.status, 200, `${what}: HTTP ${r.res.status} ${r.res.text.slice(0, 200)}`);
    assert.ok(!r.json.err, `${what}: ${r.json.err} ${r.json.msg || ''}`);
    return r.json;
};

const denied = (r, what) => {
    assert.ok([401, 403].includes(r.res.status), `${what}: expected 401/403, got ${r.res.status} ${r.res.text.slice(0, 200)}`);
};

const listedHrefs = async (jar, folder) => {
    const {res, json} = await apiAs(jar, {action: 'get', items: {href: folder, what: 1}});
    if (res.status !== 200 || !json || json.err) {
        return [];
    }
    return json.items.map(i => i.href);
};

before(async () => {
    admin = await adminLogin();
    ok(await adminOp(admin.jar, admin.csrf, 'user.save', {user: ALICE}), 'user.save alice');
    ok(await adminOp(admin.jar, admin.csrf, 'rule.save', {rule: RULE_PRIVATE}), 'rule.save /private/');
    ok(await adminOp(admin.jar, admin.csrf, 'rule.save', {rule: RULE_SITE}), 'rule.save /site/');

    const {res, json, jar} = await login(ALICE.name, ALICE.password);
    assert.equal(res.status, 200, `alice login: ${res.text.slice(0, 200)}`);
    assert.notEqual(json.asAdmin, true);
    assert.equal(json.user, ALICE.name);
    const {setup} = await getSetup(jar);
    alice = {jar, csrf: setup.CSRF, setup};
});

after(async () => {
    const a = admin || await adminLogin();
    await adminOp(a.jar, a.csrf, 'rule.delete', {path: RULE_PRIVATE.path});
    await adminOp(a.jar, a.csrf, 'rule.delete', {path: RULE_SITE.path});
    await adminOp(a.jar, a.csrf, 'user.delete', {name: ALICE.name});
    const list = await adminOp(a.jar, a.csrf, 'list');
    if (list.json && !list.json.err) {
        const users = (list.json.users || []).map(u => (typeof u === 'string' ? u : u.name));
        assert.ok(!users.includes(ALICE.name), 'cleanup: alice still exists');
    }
    await apiAs(a.jar, {action: 'logout', csrf: a.csrf});
    // classic open behaviour is back
    const res = await get('/private/secret.txt');
    assert.equal(res.status, 200, 'cleanup: /private/ still restricted');
});

test('admin API: list returns the created user and rules', async () => {
    const json = ok(await adminOp(admin.jar, admin.csrf, 'list'), 'list');
    const users = (json.users || []).map(u => (typeof u === 'string' ? u : u.name));
    assert.ok(users.includes('alice'), `users: ${JSON.stringify(json.users)}`);
    assert.ok(!JSON.stringify(json.users).includes('pw-alice-123'), 'plaintext password returned');
    const paths = (json.rules || []).map(r => r.path);
    assert.ok(paths.includes('/private/') && paths.includes('/site/'), `rules: ${JSON.stringify(json.rules)}`);
});

test('admin API: requires CSRF token, admin role and same origin', async () => {
    const noCsrf = await apiAs(admin.jar, {action: 'admin', op: 'list'});
    denied(noCsrf, 'admin op without csrf');
    const badCsrf = await adminOp(admin.jar, 'x'.repeat(40), 'list');
    denied(badCsrf, 'admin op with wrong csrf');
    const guest = await api({action: 'admin', op: 'list', csrf: admin.csrf});
    denied(guest, 'admin op as guest');
    const asAlice = await adminOp(alice.jar, alice.csrf, 'user.save', {user: {name: 'mallory', password: 'x-123456789', roles: ['admin']}});
    denied(asAlice, 'admin op as non-admin user');
});

test('alice session reports her roles', async () => {
    assert.equal(alice.setup.USER.name, 'alice');
    assert.ok(alice.setup.USER.roles.includes('user'));
    assert.equal(alice.setup.USER.isAdmin, false);
    assert.equal(alice.setup.AS_ADMIN, false);
});

test('guest: file gate denies restricted files with 401', async () => {
    for (const p of ['/private/secret.txt', '/private/photo.jpg', '/private/report.pdf']) {
        const res = await get(p);
        assert.equal(res.status, 401, `${p} -> ${res.status}`);
        assert.ok(!res.text.includes('TOP-SECRET'));
    }
    const range = await get('/private/secret.txt', {headers: {Range: 'bytes=0-3'}});
    assert.equal(range.status, 401);
});

test('guest: internal redirect to a folder index file is gated too (/site/ -> index.html)', async () => {
    const res = await get('/site/');
    assert.equal(res.status, 401, `/site/ -> ${res.status}`);
    assert.ok(!res.text.includes('Unmanaged site'));
    assert.equal((await get('/site/index.html')).status, 401);
});

test('guest: restricted folder is invisible in listings, search, thumbs and downloads', async () => {
    const root = await listedHrefs(null, '/');
    assert.ok(!root.includes('/private/'), 'root listing shows /private/');
    assert.ok(root.includes('/team/'), 'unrestricted folders stay visible');
    const inside = await listedHrefs(null, '/private/');
    assert.ok(!inside.some(h => h.startsWith('/private/') && h !== '/private/'), `listing: ${inside}`);

    const page = await api({action: 'get', items: {href: '/private/', what: 1}}, {path: '/private/'});
    assert.ok(!page.res.text.includes('secret.txt'), 'POST to /private/ lists files');

    const s = await api({action: 'get', search: {href: '/', pattern: 'secret', ignorecase: true}});
    const found = (s.json && Array.isArray(s.json.search) ? s.json.search : []).map(i => i.href);
    assert.ok(!found.some(h => h.startsWith('/private/')), `search leaks: ${found}`);

    const t = await thumb({type: 'img', href: '/private/photo.jpg', width: 100, height: 100});
    assert.ok(!t.url, 'thumbnail of a restricted image');

    const custom = await api({action: 'get', custom: '/private/'});
    assert.ok(custom.res.status < 500);

    const dl = await form('/', {action: 'download', as: 'p.tar', type: 'php-tar', baseHref: '/private/', hrefs: ''});
    assert.ok([401, 403].includes(dl.status) && errorOf(dl) && !isTar(dl.body), `guest download of /private/: ${dl.status}`);
    const dl2 = await form('/', {action: 'download', as: 'p.tar', type: 'php-tar', baseHref: '/', hrefs: ['/private/secret.txt']});
    assert.ok(!isTar(dl2.body) || !dl2.body.includes(Buffer.from('TOP-SECRET')), 'restricted file packaged for guest');
});

test('guest: unrestricted content is unaffected', async () => {
    const res = await get('/team/notes.txt');
    assert.equal(res.status, 200);
    assert.equal(res.text, 'team notes\n');
});

test('alice (read): can list and fetch restricted files, incl. Range', async () => {
    const inside = await listedHrefs(alice.jar, '/private/');
    assert.ok(inside.includes('/private/secret.txt'), `alice listing: ${inside}`);
    const root = await listedHrefs(alice.jar, '/');
    assert.ok(root.includes('/private/'), 'alice sees /private/ in the root listing');

    const res = await get('/private/secret.txt', {headers: withJar(alice.jar)});
    assert.equal(res.status, 200);
    assert.equal(res.text, PRIVATE_SECRET);
    assert.ok(!/(^|,|\s)public/i.test(res.headers['cache-control'] || ''),
        `permission-gated file is publicly cacheable: ${res.headers['cache-control']}`);

    const range = await get('/private/secret.txt', {headers: withJar(alice.jar, {Range: 'bytes=0-3'})});
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-range'], `bytes 0-3/${Buffer.byteLength(PRIVATE_SECRET)}`);
    assert.equal(range.text, 'TOP-');
});

test('alice (read): packaged download needs the "download" level -> 403', async () => {
    const dl = await form('/', {action: 'download', as: 'p.tar', type: 'php-tar', baseHref: '/private/', hrefs: ''},
        {headers: withJar(alice.jar)});
    assert.equal(dl.status, 403, `alice download: ${dl.status} ${dl.text.slice(0, 120)}`);
    assert.ok(!isTar(dl.body));
});

test('alice: rule "*": "none" on /site/ applies to her as well', async () => {
    const res = await get('/site/', {headers: withJar(alice.jar)});
    assert.ok([401, 403].includes(res.status), `/site/ for alice -> ${res.status}`);
});

test('alice: logout drops access', async () => {
    const {jar} = await login(ALICE.name, ALICE.password);
    const {setup} = await getSetup(jar);
    await apiAs(jar, {action: 'logout', csrf: setup.CSRF});
    const res = await get('/private/secret.txt', {headers: withJar(jar)});
    assert.equal(res.status, 401);
});

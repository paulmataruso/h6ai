// Anonymous mode (admin setting visitors.anonymous): no sign-in for visitors, everyone browses and
// downloads everything except excluded folders ("everyone: none" rules). Only admins sign in.
// Everything changed here is reset in after().
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {get, apiAs, login, getSetup, adminSession, adminOp, okJson, withJar} from './lib.mjs';

const BOB = {name: 'bob-anonmode', password: 'pw-bob-anonmode-1', roles: ['user'], create: true};
const EXCLUDED = {path: '/team/', grants: {'*': 'none'}};

let admin = null;
let bob = null; // session of a standard account, opened before anonymous mode is switched on

const op = (name, payload) => adminOp(admin.jar, admin.csrf, name, payload).then(r => okJson(r, name));
const setAnonymous = on => op('settings.save', {settings: {visitors: {anonymous: on}}});
const listing = async (jar, folder) => {
    const {res, json} = await apiAs(jar, {action: 'get', items: {href: folder, what: 1}});
    assert.equal(res.status, 200);
    return json;
};

before(async () => {
    admin = await adminSession();
    await op('user.save', {user: BOB});
    const {json, jar} = await login(BOB.name, BOB.password);
    assert.equal(json.user, BOB.name, 'bob logs in while anonymous mode is off');
    bob = jar;
    await op('rule.save', {rule: EXCLUDED});
    await setAnonymous(true);
});

after(async () => {
    if (!admin) {
        return;
    }
    await setAnonymous(false);
    await op('rule.delete', {path: EXCLUDED.path});
    await op('user.delete', {name: BOB.name});
});

test('the setting is saved and every visitor learns there is no sign-in', async () => {
    const {settings} = await op('settings.get');
    assert.equal(settings.visitors.anonymous, true);
    const {setup} = await getSetup(null);
    assert.equal(setup.AUTH.anonymous, true);
    assert.equal(setup.USER, null);
});

test('visitors browse and download everything except excluded folders', async () => {
    const root = await listing(null, '/');
    const hrefs = root.items.map(i => i.href);
    assert.ok(hrefs.includes('/docs/'), 'docs listed');
    assert.ok(!hrefs.includes('/team/'), 'excluded folder listed');
    assert.equal((await get('/docs/readme.md')).status, 200);
    assert.equal((await get('/big/big.bin', {headers: {Range: 'bytes=0-15'}})).status, 206);
    // nothing to log in to: 403 rather than 401
    assert.equal((await get('/team/notes.txt')).status, 403);
});

test('an excluded folder is "unavailable", not a login prompt', async () => {
    const json = await listing(null, '/team/');
    assert.equal(json.denied, 'unavailable');
    assert.ok(!(json.items || []).some(i => i.href === '/team/notes.txt'), 'contents leaked');
});

test('only admins can sign in, other accounts fail like a wrong password', async () => {
    const {res, json} = await login(BOB.name, BOB.password);
    assert.equal(res.status, 200);
    assert.equal(json.user, null, 'a standard account signed in');
    const again = await adminSession();
    assert.equal(again.setup.USER.isAdmin, true);
});

test('sessions of other accounts count as visitors', async () => {
    const {setup} = await getSetup(bob);
    assert.equal(setup.USER, null);
    assert.equal((await listing(bob, '/team/')).denied, 'unavailable');
    assert.equal((await get('/team/notes.txt', {headers: withJar(bob)})).status, 403);
});

test('admins still see and open excluded folders', async () => {
    const root = await listing(admin.jar, '/');
    assert.ok(root.items.some(i => i.href === '/team/'));
    assert.equal((await get('/team/notes.txt', {headers: withJar(admin.jar)})).status, 200);
});

test('switching it off brings sign-in back, and the old sessions with it', async () => {
    await setAnonymous(false);
    const {setup} = await getSetup(null);
    assert.equal(setup.AUTH.anonymous, false);
    assert.equal(setup.AUTH.loginAvailable, true);
    assert.equal((await get('/team/notes.txt')).status, 401);
    assert.equal((await listing(null, '/team/')).denied, 'login');
    assert.equal((await getSetup(bob)).setup.USER.name, BOB.name);
});

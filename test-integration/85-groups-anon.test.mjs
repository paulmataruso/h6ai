// Folder groups (named lists of folders) assigned to users and roles with an access level, and
// "anon" accounts: download-only accounts that see nothing but the folder groups assigned to them
// (default deny, "*" grants don't apply). Everything created here is removed in after().
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {
    get, form, apiAs, login, getSetup, adminSession, adminOp, supportsAdminOp, okJson, withJar,
    thumb, isTar, PRIVATE_SECRET
} from './lib.mjs';

const GROUP = {name: 'clients', description: 'client deliverables', paths: ['/team/', '/docs/']};
const VAULT = {name: 'vault', description: 'restricted', paths: ['/private/']};
const ANON = {name: 'anon-client', password: 'pw-anon-client-1', type: 'anon', roles: [], create: true,
    access: [{group: 'clients', level: 'download'}]};
const DAVE = {name: 'dave-groups', password: 'pw-dave-groups-1', roles: ['user'], create: true,
    access: [{group: 'vault', level: 'read'}]};
const STAFF = {name: 'staff-groups', description: 'test role', access: [{group: 'vault', level: 'download'}]};
const ERIN = {name: 'erin-groups', password: 'pw-erin-groups-1', roles: ['staff-groups'], create: true};
const RULE_PRIVATE = {path: '/private/', grants: {'*': 'none'}};

let admin = null;
let hasGroups = false;
const sessions = {};

const session = async user => {
    if (!sessions[user.name]) {
        const {res, json, jar} = await login(user.name, user.password);
        assert.equal(res.status, 200, `${user.name} login: ${res.text.slice(0, 200)}`);
        assert.equal(json.user, user.name, `${user.name} login failed`);
        const {setup} = await getSetup(jar);
        sessions[user.name] = {jar, csrf: setup.CSRF, setup};
    }
    return sessions[user.name];
};

const children = async (jar, folder) => {
    const {res, json} = await apiAs(jar, {action: 'get', items: {href: folder, what: 1}});
    assert.equal(res.status, 200);
    return (json.items || []).map(i => i.href)
        .filter(h => h !== folder && h.startsWith(folder) && !h.slice(folder.length).replace(/\/$/, '').includes('/'));
};

const skipIfPending = t => {
    if (!hasGroups) {
        t.skip('backend pending: folder groups / anon accounts (admin op group.save)');
        return true;
    }
    return false;
};

before(async () => {
    admin = await adminSession();
    hasGroups = await supportsAdminOp(admin, 'group.save', {group: GROUP});
    if (!hasGroups) {
        return;
    }
    const op = (name, payload) => adminOp(admin.jar, admin.csrf, name, payload).then(r => okJson(r, name));
    await op('group.save', {group: GROUP});
    await op('group.save', {group: VAULT});
    await op('role.save', {role: STAFF});
    await op('user.save', {user: ANON});
    await op('user.save', {user: DAVE});
    await op('user.save', {user: ERIN});
    await op('rule.save', {rule: RULE_PRIVATE});
});

after(async () => {
    if (!admin) {
        return;
    }
    for (const name of [ANON.name, DAVE.name, ERIN.name]) {
        await adminOp(admin.jar, admin.csrf, 'user.delete', {name});
    }
    await adminOp(admin.jar, admin.csrf, 'role.delete', {name: STAFF.name});
    await adminOp(admin.jar, admin.csrf, 'rule.delete', {path: RULE_PRIVATE.path});
    for (const name of [GROUP.name, VAULT.name]) {
        await adminOp(admin.jar, admin.csrf, 'group.delete', {name});
    }
});

test('admin list returns folder groups with paths and members', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const json = okJson(await adminOp(admin.jar, admin.csrf, 'list'), 'list');
    const g = (json.groups || []).find(x => x.name === GROUP.name);
    assert.ok(g, 'group listed');
    assert.equal(g.description, GROUP.description);
    assert.deepEqual([...g.paths].sort(), [...GROUP.paths].sort());
    assert.ok('members' in g, 'members');
    const anon = json.users.find(u => u.name === ANON.name);
    assert.equal(anon.type, 'anon');
    assert.deepEqual(anon.access, ANON.access);
});

test('group paths are validated (no traversal, must be folders)', async t => {
    if (skipIfPending(t)) {
        return;
    }
    for (const paths of [['/../outside/'], ['/team/../../']]) {
        const r = await adminOp(admin.jar, admin.csrf, 'group.save', {group: {name: 'bad-group', paths}});
        assert.equal(r.res.status, 400, `${paths}: ${r.res.status}`);
    }
    const bad = await adminOp(admin.jar, admin.csrf, 'user.save', {user: {...ANON, name: 'anon-bad', access: [{group: 'nope', level: 'read'}]}});
    assert.equal(bad.res.status, 400, 'unknown group');
    const badLevel = await adminOp(admin.jar, admin.csrf, 'user.save', {user: {...ANON, name: 'anon-bad', access: [{group: 'clients', level: 'write'}]}});
    assert.equal(badLevel.res.status, 400, 'unknown level');
});

test('anon: setup reports the account type', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const s = await session(ANON);
    assert.equal(s.setup.USER.name, ANON.name);
    assert.equal(s.setup.USER.type, 'anon');
    assert.equal(s.setup.USER.isAdmin, false);
});

test('anon: sees only the folders of its groups', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const s = await session(ANON);
    const root = await children(s.jar, '/');
    assert.deepEqual(root.sort(), ['/docs/', '/team/'], `root listing: ${root}`);
    assert.ok((await children(s.jar, '/team/')).includes('/team/notes.txt'));
    assert.deepEqual(await children(s.jar, '/images/'), [], 'images listed');

    const search = await apiAs(s.jar, {action: 'get', search: {href: '/', pattern: 'photo', ignorecase: true}});
    const found = ((search.json && search.json.search) || []).map(i => i.href);
    assert.ok(!found.some(h => !h.startsWith('/docs/') && !h.startsWith('/team/')), `search leaks: ${found}`);

    const th = await thumb({type: 'img', href: '/images/photo.jpg', width: 100, height: 100}, {jar: s.jar});
    assert.ok(!th.url, 'thumbnail outside the groups');
});

test('anon: default deny at the file gate, even where "*" would allow', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const s = await session(ANON);
    const photo = await get('/images/photo.jpg', {headers: withJar(s.jar)});
    assert.ok([401, 403].includes(photo.status), `/images/photo.jpg: ${photo.status}`);
    const secret = await get('/private/secret.txt', {headers: withJar(s.jar)});
    assert.ok([401, 403].includes(secret.status));
    // guests still see the public folder (anon restrictions are per account)
    assert.equal((await get('/images/photo.jpg')).status, 200);
});

test('anon: can download files and folder archives of its groups', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const s = await session(ANON);
    const file = await get('/docs/notes.txt', {headers: withJar(s.jar)});
    assert.equal(file.status, 200);
    const tar = await form('/team/', {action: 'download', as: 't.tar', type: 'php-tar', baseHref: '/team/', hrefs: ''},
        {headers: withJar(s.jar)});
    assert.equal(tar.status, 200, tar.text.slice(0, 200));
    assert.ok(isTar(tar.body));
    const outside = await form('/images/', {action: 'download', as: 'i.tar', type: 'php-tar', baseHref: '/images/', hrefs: ''},
        {headers: withJar(s.jar)});
    assert.ok([401, 403].includes(outside.status) && !isTar(outside.body), `images archive: ${outside.status}`);
});

test('anon: cannot change its password or use admin operations', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const s = await session(ANON);
    const pw = await apiAs(s.jar, {action: 'password', csrf: s.csrf, current: ANON.password, new: 'something-else-1'});
    assert.equal(pw.res.status, 403);
    const op = await adminOp(s.jar, s.csrf, 'list');
    assert.equal(op.res.status, 403);
});

test('a group level of "read" allows files but not archives', async t => {
    if (skipIfPending(t)) {
        return;
    }
    okJson(await adminOp(admin.jar, admin.csrf, 'user.save', {user: {...ANON, create: false, password: '', access: [{group: 'clients', level: 'read'}]}}), 'downgrade');
    delete sessions[ANON.name]; // access change invalidates the session
    const s = await session(ANON);
    assert.equal((await get('/docs/notes.txt', {headers: withJar(s.jar)})).status, 200);
    const tar = await form('/team/', {action: 'download', as: 't.tar', type: 'php-tar', baseHref: '/team/', hrefs: ''},
        {headers: withJar(s.jar)});
    assert.equal(tar.status, 403, `read-only archive: ${tar.status}`);
    okJson(await adminOp(admin.jar, admin.csrf, 'user.save', {user: {...ANON, create: false, password: ''}}), 'restore');
    delete sessions[ANON.name];
});

test('standard users get extra folders through groups, beside "*" grants', async t => {
    if (skipIfPending(t)) {
        return;
    }
    // /private/ is "*": none; dave gets it via the vault group (read)
    const dave = await session(DAVE);
    const secret = await get('/private/secret.txt', {headers: withJar(dave.jar)});
    assert.equal(secret.status, 200);
    assert.equal(secret.text, PRIVATE_SECRET);
    assert.equal((await get('/images/photo.jpg', {headers: withJar(dave.jar)})).status, 200, 'standard users keep public access');
    const tar = await form('/private/', {action: 'download', as: 'p.tar', type: 'php-tar', baseHref: '/private/', hrefs: ''},
        {headers: withJar(dave.jar)});
    assert.equal(tar.status, 403, 'read level: no archives');
    assert.equal((await get('/private/secret.txt')).status, 401, 'guests still locked out');
});

test('roles get folder groups too', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const erin = await session(ERIN);
    const tar = await form('/private/', {action: 'download', as: 'p.tar', type: 'php-tar', baseHref: '/private/', hrefs: ''},
        {headers: withJar(erin.jar)});
    assert.equal(tar.status, 200, `role download: ${tar.status} ${tar.text.slice(0, 120)}`);
    assert.ok(isTar(tar.body));
});

test('deleting a group removes it from users and roles', async t => {
    if (skipIfPending(t)) {
        return;
    }
    okJson(await adminOp(admin.jar, admin.csrf, 'group.delete', {name: VAULT.name}), 'group.delete');
    const json = okJson(await adminOp(admin.jar, admin.csrf, 'list'), 'list');
    assert.ok(!(json.groups || []).some(g => g.name === VAULT.name));
    const dave = json.users.find(u => u.name === DAVE.name);
    assert.ok(!(dave.access || []).some(a => a.group === VAULT.name), 'user still references the group');
    const staff = json.roles.find(r => r.name === STAFF.name);
    assert.ok(!(staff.access || []).some(a => a.group === VAULT.name), 'role still references the group');
    delete sessions[DAVE.name];
    const d = await session(DAVE);
    assert.ok([401, 403].includes((await get('/private/secret.txt', {headers: withJar(d.jar)})).status));
});

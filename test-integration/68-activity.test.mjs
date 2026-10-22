// Activity log: file downloads (seen by the nginx gate) and archive downloads are recorded with
// user, IP and path; partial Range reads (video seeking) and HEAD requests are not.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {request, get, form, login, getSetup, adminSession, adminOp, supportsAdminOp, okJson, withJar, isTar} from './lib.mjs';

const CAROL = {name: 'carol-activity', password: 'pw-carol-activity-1', roles: ['user'], create: true};

let admin = null;
let hasActivity = false;
let hasSettings = false;
let originalLog = null;
let since = 0;

const list = async () => okJson(await adminOp(admin.jar, admin.csrf, 'activity.list', {limit: 50}), 'activity.list');

// The gate may write the entry after answering nginx: poll briefly.
const findEntry = async (predicate, ms = 4000) => {
    const until = Date.now() + ms;
    let entries = [];
    while (Date.now() < until) {
        entries = (await list()).entries;
        const hit = entries.find(predicate);
        if (hit) {
            return {hit, entries};
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return {hit: null, entries};
};

const timeOf = e => (typeof e.time === 'number' ? (e.time < 1e12 ? e.time * 1000 : e.time) : Date.parse(e.time));
const recent = e => timeOf(e) >= since - 5000;

const skipIfPending = t => {
    if (!hasActivity) {
        t.skip('backend pending: admin op activity.list');
        return true;
    }
    return false;
};

before(async () => {
    admin = await adminSession();
    hasActivity = await supportsAdminOp(admin, 'activity.list', {limit: 1});
    hasSettings = await supportsAdminOp(admin, 'settings.get');
    if (hasSettings) {
        const s = okJson(await adminOp(admin.jar, admin.csrf, 'settings.get'), 'settings.get').settings;
        originalLog = s.activityLog;
        okJson(await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {activityLog: {enabled: true}}}), 'enable log');
    }
    if (hasActivity) {
        okJson(await adminOp(admin.jar, admin.csrf, 'user.save', {user: CAROL}), 'user.save carol');
    }
    since = Date.now();
});

after(async () => {
    if (admin) {
        await adminOp(admin.jar, admin.csrf, 'user.delete', {name: CAROL.name});
        if (hasSettings && originalLog) {
            await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {activityLog: originalLog}});
        }
    }
});

test('a guest file download is logged (user null, kind file)', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const res = await get('/docs/notes.txt');
    assert.equal(res.status, 200);
    const {hit, entries} = await findEntry(e => recent(e) && e.path === '/docs/notes.txt' && e.kind === 'file');
    assert.ok(hit, `not logged; latest: ${JSON.stringify(entries.slice(0, 3))}`);
    assert.equal(hit.user, null);
    assert.ok(typeof hit.ip === 'string' && hit.ip.length > 0, 'ip');
});

test('an archive download by a logged in user is logged (kind archive)', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const {jar, json} = await login(CAROL.name, CAROL.password);
    assert.equal(json.user, CAROL.name);
    const res = await form('/team/', {action: 'download', as: 'team.tar', type: 'php-tar', baseHref: '/team/', hrefs: ''},
        {headers: withJar(jar)});
    assert.equal(res.status, 200);
    assert.ok(isTar(res.body));
    const {hit, entries} = await findEntry(e => recent(e) && e.kind === 'archive' && e.user === CAROL.name);
    assert.ok(hit, `archive not logged; latest: ${JSON.stringify(entries.slice(0, 3))}`);
    assert.match(hit.path, /^\/team\//);
});

test('entries are newest first and carry the documented fields', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const {entries, stats} = await list();
    assert.ok(Array.isArray(entries) && entries.length >= 2);
    // besides downloads the log may contain other events (e.g. logins)
    assert.ok(entries.some(e => e.kind === 'file') && entries.some(e => e.kind === 'archive'), 'file and archive entries');
    assert.ok(stats && typeof stats === 'object', 'stats');
    for (const e of entries.slice(0, 10)) {
        for (const key of ['time', 'user', 'ip', 'path', 'kind']) {
            assert.ok(key in e, `${key} in ${JSON.stringify(e)}`);
        }
        assert.equal(typeof e.kind, 'string', 'kind');
    }
    for (let i = 1; i < Math.min(entries.length, 20); i += 1) {
        assert.ok(timeOf(entries[i - 1]) >= timeOf(entries[i]), 'not sorted newest first');
    }
});

test('partial Range reads and HEAD requests are not logged; Range from 0 is', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const mark = Date.now();
    // entries from earlier tests (e.g. full big.bin downloads seconds ago) are not ours
    const key = e => JSON.stringify(e);
    const seen = new Set((await list()).entries.map(key));
    assert.equal((await get('/big/big.bin', {headers: {Range: 'bytes=1048576-1049599'}})).status, 206);
    assert.equal((await request('HEAD', '/docs/data.json')).status, 200);
    assert.equal((await get('/docs/code.js', {headers: {Range: 'bytes=0-9'}})).status, 206);

    const {hit} = await findEntry(e => timeOf(e) >= mark - 5000 && e.path === '/docs/code.js');
    assert.ok(hit, 'Range starting at 0 is a (start of a) download');
    const {entries} = await list();
    const newer = entries.filter(e => !seen.has(key(e)));
    assert.ok(!newer.some(e => e.path === '/big/big.bin'), 'mid-file Range read was logged');
    assert.ok(!newer.some(e => e.path === '/docs/data.json'), 'HEAD request was logged');
});

test('the activity log is admin only', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const {jar} = await login(CAROL.name, CAROL.password);
    const {setup} = await getSetup(jar);
    const r = await adminOp(jar, setup.CSRF, 'activity.list', {limit: 5});
    assert.equal(r.res.status, 403);
});

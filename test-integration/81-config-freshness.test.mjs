// Regression: h6ai caches its JSON data (rules, users, settings) keyed by file mtime and size.
// mtime has a resolution of one second, so two saves of the same size within one second used to
// leave the first version in effect until the next save. Each check saves twice in a row, a few
// times over, so at least some pairs land in the same second.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {get, apiAs, getSetup, adminSession, adminOp, okJson} from './lib.mjs';

const ROUNDS = 6;
let admin = null;

const op = (name, payload) => adminOp(admin.jar, admin.csrf, name, payload).then(r => okJson(r, name));

before(async () => {
    admin = await adminSession();
});

after(async () => {
    if (admin) {
        await op('rule.delete', {path: '/docs/'});
        await op('settings.save', {settings: {siteName: 'h6ai'}});
    }
});

test('a folder rule changed twice in a row takes effect at once', async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
        // "list" and "none" have the same length: the same file size
        await op('rule.save', {rule: {path: '/docs/', grants: {'*': 'list'}}});
        await op('rule.save', {rule: {path: '/docs/', grants: {'*': 'none'}}});
        const {json} = await apiAs(null, {action: 'get', items: {href: '/', what: 1}});
        assert.ok(!json.items.some(item => item.href === '/docs/'), `round ${i}: /docs/ still listed for guests`);
        assert.equal((await get('/docs/readme.md')).status, 401, `round ${i}: file still served`);
    }
});

test('settings saved twice in a row take effect at once', async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
        await op('settings.save', {settings: {siteName: 'fresh-a'}});
        await op('settings.save', {settings: {siteName: 'fresh-b'}});
        assert.equal((await getSetup(null)).setup.SITE.name, 'fresh-b', `round ${i}`);
    }
});

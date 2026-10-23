// An h5ai install left in the shared folder after a move to h6ai (docker/seed.sh seeds one): its
// private/conf/options.json holds h5ai's password hash. h6ai never lists, searches, archives or
// serves anything inside an _h5ai folder, also on direct links, whatever view.hidden says.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {get, api, form, errorOf, isTar, isZip, adminSession, apiAs} from './lib.mjs';

const MARKER = 'H5AI-LEFTOVER-PASSHASH';

test('direct links into _h5ai are refused, in any spelling', async () => {
    for (const path of [
        '/_h5ai/private/conf/options.json',
        '/%5Fh5ai/private/conf/options.json',
        '/_H5AI/private/conf/options.json',
        '/docs/../_h5ai/private/conf/options.json',
        '/_h5ai/public/index.php',
        '/_h5ai/'
    ]) {
        const res = await get(path);
        assert.ok([403, 404].includes(res.status), `${path}: HTTP ${res.status}`);
        assert.ok(!res.text.includes(MARKER) && !res.text.includes('H5AI-LEFTOVER-RAN'), `${path}: leaked ${res.text.slice(0, 80)}`);
    }
});

test('_h5ai is not listed, searched or browsable through the API', async () => {
    const root = await api({action: 'get', items: {href: '/', what: 1}});
    assert.equal(root.res.status, 200);
    assert.ok(!root.json.items.some(i => /\/_h5ai\//i.test(i.href)), 'root listing shows _h5ai');

    const inside = await api({action: 'get', items: {href: '/_h5ai/', what: 1}});
    assert.ok(!(inside.json && inside.json.items || []).some(i => /options\.json/.test(i.href)), 'listing inside _h5ai');

    const found = await api({action: 'get', search: {href: '/', pattern: 'options', ignorecase: true}});
    const hits = (found.json && found.json.search || []).map(i => i.href);
    assert.ok(!hits.some(h => /_h5ai/i.test(h)), `search finds ${hits.join(', ')}`);
});

test('_h5ai can\'t be downloaded as an archive', async () => {
    for (const fields of [
        {baseHref: '/_h5ai/', hrefs: ''},
        {baseHref: '/', hrefs: ['/_h5ai/']},
        {baseHref: '/', hrefs: ['/_h5ai/private/conf/options.json']}
    ]) {
        const res = await form('/', {action: 'download', as: 'x.tar', type: 'php-tar', ...fields});
        assert.ok(res.status >= 400 && errorOf(res), `${JSON.stringify(fields)}: HTTP ${res.status}`);
        assert.ok(!isTar(res.body) && !isZip(res.body), `${JSON.stringify(fields)}: got an archive`);
    }
});

test('the admin page learns about the leftover folder', async () => {
    const admin = await adminSession();
    assert.equal(admin.setup.HAS_H5AI_FOLDER, true);
    await apiAs(admin.jar, {action: 'logout', csrf: admin.csrf});
});

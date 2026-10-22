// Packaged downloads (S10): scope checks, hidden files, header injection, PAX long names.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    form, errorOf, isTar, isZip, tarList, zipList,
    DEEP_D1, DEEP_D2, DEEP_LONG_REL
} from './lib.mjs';

const download = (path, fields) => form(path, {action: 'download', as: 'test.tar', type: 'php-tar', ...fields});

const assertRejected = (res, what) => {
    assert.ok(res.status >= 400 && res.status < 500, `${what}: expected 4xx, got ${res.status}`);
    assert.ok(errorOf(res), `${what}: expected a JSON error, got ${res.body.subarray(0, 80).toString('latin1')}`);
    assert.ok(!isTar(res.body) && !isZip(res.body), `${what}: got an archive`);
};

test('S10: php-tar keeps paths longer than 255 bytes (PAX headers)', async () => {
    const res = await download('/deep/', {baseHref: '/deep/', hrefs: [`/deep/${DEEP_D1}/`]});
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.ok(isTar(res.body), 'response is a tar');
    const entries = tarList(res.body);
    assert.ok(entries.some(e => e.replace(/^\//, '') === DEEP_LONG_REL),
        `long path missing; entries:\n${entries.map(e => `${e.length} ${e.slice(0, 60)}...`).join('\n')}`);
    assert.ok(entries.some(e => e.replace(/^\//, '') === `${DEEP_D1}/short.txt`));
    assert.ok(entries.some(e => e.replace(/^\//, '').replace(/\/$/, '') === `${DEEP_D1}/${DEEP_D2}`), 'directory entry');
});

test('S10: whole-folder download (no hrefs) works', async () => {
    const res = await download('/deep/', {baseHref: '/deep/', hrefs: ''});
    assert.equal(res.status, 200);
    const entries = tarList(res.body);
    assert.ok(entries.some(e => /(^|\/)small\.txt$/.test(e)), entries.join('\n'));
});

test('S10: hidden files are never packaged', async () => {
    const res = await download('/visible/', {baseHref: '/visible/', hrefs: ''});
    assert.equal(res.status, 200);
    const entries = tarList(res.body);
    assert.ok(entries.some(e => e.endsWith('public.txt')), entries.join('\n'));
    assert.ok(!entries.some(e => e.includes('.secret')), `hidden file packaged: ${entries}`);

    const explicit = await download('/visible/', {baseHref: '/visible/', hrefs: ['/visible/.secret.jpg']});
    if (explicit.status === 200 && isTar(explicit.body)) {
        assert.ok(!tarList(explicit.body).some(e => e.includes('.secret')), 'explicitly requested hidden file packaged');
    } else {
        assertRejected(explicit, 'explicit hidden href');
    }
});

test('S10: hrefs outside baseHref are rejected', async () => {
    assertRejected(await download('/deep/', {baseHref: '/deep/', hrefs: ['/images/photo.jpg']}), 'sibling folder');
    assertRejected(await download('/deep/', {baseHref: '/deep/', hrefs: ['/deep/small.txt', '/docs/notes.txt']}), 'mixed');
});

test('S10: traversal in baseHref or hrefs is rejected', async () => {
    const cases = [
        {baseHref: '/deep/', hrefs: ['/deep/../../outside/secret.jpg']},
        {baseHref: '/deep/', hrefs: ['/deep/%2e%2e/%2e%2e/outside/secret.txt']},
        {baseHref: '/deep/', hrefs: ['/deep/../.hidden/secret.txt']},
        {baseHref: '/../outside/', hrefs: ''},
        {baseHref: '/%2e%2e/outside/', hrefs: ''},
        {baseHref: '/.hidden/', hrefs: ''},
        {baseHref: '/_h6ai/private/conf/', hrefs: ''}
    ];
    for (const c of cases) {
        assertRejected(await download('/', c), JSON.stringify(c));
    }
});

test('S10: archive filename cannot inject headers and is RFC 6266 encoded', async () => {
    const res = await download('/deep/', {baseHref: '/deep/', hrefs: ['/deep/small.txt'], as: 'evil"\r\nX-Injected: 1;.tar'});
    assert.equal(res.status, 200);
    assert.ok(!res.headers['x-injected'], 'header injection');
    const cd = res.headers['content-disposition'] || '';
    assert.match(cd, /^attachment/i, `Content-Disposition: ${cd}`);
    assert.match(cd, /filename\*=UTF-8''/i, `Content-Disposition: ${cd}`);
    const quoted = /filename="((?:[^"\\]|\\.)*)"/.exec(cd);
    if (quoted) {
        assert.ok(!/[\r\n]/.test(quoted[1]), 'CR/LF in filename');
    }

    const uni = await download('/deep/', {baseHref: '/deep/', hrefs: ['/deep/small.txt'], as: 'Ünïcödé 日本.tar'});
    assert.match(uni.headers['content-disposition'] || '', /filename\*=UTF-8''%C3%9Cn%C3%AF/i);
});

test('S10: download of a folder containing a symlink loop terminates', async () => {
    const started = Date.now();
    const res = await form('/loop/', {action: 'download', as: 'loop.tar', type: 'php-tar', baseHref: '/loop/', hrefs: ''},
        {timeout: 60000});
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 60000);
    const entries = tarList(res.body);
    assert.ok(entries.some(e => e.endsWith('file.txt')));
    assert.ok(entries.length < 2000, `${entries.length} entries - loop not cut`);
});

test('S10: shell-tar and shell-zip produce valid archives (or are cleanly refused)', async t => {
    for (const [type, check, list] of [['shell-tar', isTar, tarList], ['shell-zip', isZip, zipList]]) {
        const res = await form('/deep/', {action: 'download', as: `test.${type}`, type, baseHref: '/deep/', hrefs: ['/deep/small.txt']});
        if (res.status !== 200 && errorOf(res)) {
            t.diagnostic(`${type}: refused with ${res.status} ${errorOf(res)} (only the configured type may be allowed)`);
            continue;
        }
        assert.equal(res.status, 200, `${type}: ${res.status}`);
        assert.ok(check(res.body), `${type}: not a valid archive`);
        assert.ok(list(res.body).some(e => e.endsWith('small.txt')), `${type}: small.txt missing`);
    }
});

test('S10: unknown archive type is rejected', async () => {
    const res = await form('/deep/', {action: 'download', as: 'x', type: 'shell-rm', baseHref: '/deep/', hrefs: ''});
    assertRejected(res, 'unknown type');
});

// Server-side search: ReDoS / delimiter injection / hidden paths / symlink loops (S9).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api, DEEP_D1} from './lib.mjs';

const search = async (href, pattern, ignorecase = true) => {
    const started = Date.now();
    const {res, json} = await api({action: 'get', search: {href, pattern, ignorecase}}, {timeout: 30000});
    return {res, json, ms: Date.now() - started};
};

const assertJson = (r, what) => {
    assert.ok(r.json, `${what}: non-JSON response (HTTP ${r.res.status}): ${r.res.text.slice(0, 200)}`);
    assert.ok(r.res.status < 500, `${what}: server error ${r.res.status}`);
    assert.ok(!/Warning|Fatal error|Notice/.test(r.res.text), `${what}: PHP diagnostics in output`);
};

const hrefsOf = r => (Array.isArray(r.json.search) ? r.json.search.map(i => i.href) : []);

test('search finds files by name (functional)', async () => {
    const r = await search('/', 'notes');
    assertJson(r, 'notes');
    assert.ok(hrefsOf(r).includes('/docs/notes.txt'), `results: ${hrefsOf(r)}`);
});

test('S9: results never contain hidden or out-of-root paths', async () => {
    const r = await search('/', 'secret');
    assertJson(r, 'secret');
    for (const h of hrefsOf(r)) {
        assert.ok(h.startsWith('/'), h);
        assert.ok(!/\/\.[^/]/.test(h), `hidden path in results: ${h}`);
        assert.ok(!h.includes('/_h6ai'), `_h6ai path in results: ${h}`);
        assert.ok(!h.includes('outside'), `outside path in results: ${h}`);
    }
});

test('S9: search below a traversal href returns nothing', async () => {
    for (const href of ['/../', '/%2e%2e/', '/../outside/', '/images/../../']) {
        const r = await search(href, 'secret');
        assertJson(r, href);
        assert.ok(r.json.err || hrefsOf(r).length === 0, `${href}: ${hrefsOf(r)}`);
    }
});

test('S9: delimiter / modifier injection is harmless', async () => {
    for (const pattern of ['a\\@', '@e', 'x@i', '\\', 'a\\', '/', '#', '~', '\u0000']) {
        const r = await search('/', pattern);
        assertJson(r, `pattern ${JSON.stringify(pattern)}`);
    }
});

test('S9: invalid regular expressions yield a JSON answer', async () => {
    for (const pattern of ['(', '[a-', '*', '(?<', '\\k']) {
        const r = await search('/', pattern);
        assertJson(r, `pattern ${JSON.stringify(pattern)}`);
    }
});

test('S9: catastrophic backtracking patterns finish quickly', async () => {
    assert.ok(DEEP_D1.includes('aaaaaaaaaaaaaaaa'), 'seed provides long runs of "a"');
    for (const pattern of ['(a+)+b', '(a+)+$', '(a|aa)+c', '(.*a){25}', '^(\\w+\\s?)*$']) {
        const r = await search('/', pattern);
        assertJson(r, `pattern ${pattern}`);
        assert.ok(r.ms < 5000, `pattern ${pattern} took ${r.ms} ms`);
    }
});

test('S9/S13: symlink loops do not hang search and results are bounded', async () => {
    const r = await search('/loop/', 'file');
    assertJson(r, 'loop');
    assert.ok(r.ms < 10000, `took ${r.ms} ms`);
    assert.ok(hrefsOf(r).length < 1000, `${hrefsOf(r).length} results`);
    assert.ok(hrefsOf(r).includes('/loop/file.txt'));
});

test('S9: very broad searches are capped', async () => {
    const r = await search('/', '.');
    assertJson(r, 'broad');
    assert.ok(r.ms < 15000, `took ${r.ms} ms`);
    assert.ok(hrefsOf(r).length <= 10000, `${hrefsOf(r).length} results`);
});

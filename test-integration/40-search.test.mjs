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

// ---- the search box (q): words, phrases, exclusions, wildcards, ranking (docs/SEARCH.md) ----

const find = async (href, q, opts = {}) => {
    const started = Date.now();
    const {res, json} = await api({action: 'get', search: {href, q, ignorecase: true}}, {timeout: 30000, ...opts});
    return {res, json, ms: Date.now() - started};
};

test('search info: searches say how they were answered', async () => {
    const r = await find('/', 'notes');
    assertJson(r, 'notes');
    assert.equal(typeof r.json.searchInfo, 'object', 'searchInfo missing');
    for (const key of ['indexed', 'more', 'truncated']) {
        assert.equal(typeof r.json.searchInfo[key], 'boolean', `searchInfo.${key}`);
    }
    // timings and the index state are for admins
    assert.equal(r.json.searchInfo.ms, undefined);
    assert.equal(r.json.searchInfo.reason, undefined);
    if (process.env.H6AI_SEARCH_INDEXED === '1') {
        assert.equal(r.json.searchInfo.indexed, true, 'answered without the index');
    }
});

test('search: every word must occur, in any order, case and accents ignored', async () => {
    assert.ok(hrefsOf(await find('/', 'notes txt')).includes('/docs/notes.txt'));
    assert.ok(hrefsOf(await find('/', 'TXT NOTES')).includes('/docs/notes.txt'));
    assert.ok(!hrefsOf(await find('/', 'notes pdf')).includes('/docs/notes.txt'), 'words are ANDed');
    const umlaut = hrefsOf(await find('/', 'umlaut'));
    assert.ok(umlaut.some(h => h.startsWith('/unicode/Ordner')), `accent folding: ${umlaut}`);
    const unicode = hrefsOf(await find('/', 'UNICODE'));
    assert.ok(unicode.some(h => h.startsWith('/unicode/%C3%9Cn') || h.startsWith('/unicode/Ün')), `accent folding: ${unicode}`);
});

test('search: "phrases", -exclusions, wildcards and re:', async () => {
    assert.ok(hrefsOf(await find('/unicode/', '"space name"')).some(h => h.includes('space')));
    assert.deepEqual(hrefsOf(await find('/unicode/', '"name space"')), []);

    const ex = hrefsOf(await find('/many/', 'file -1'));
    assert.ok(ex.length > 0 && !ex.some(h => /file-[^/]*1/.test(h)), `exclusion: ${ex}`);

    const pdf = hrefsOf(await find('/docs/', '*.pdf'));
    assert.ok(pdf.includes('/docs/sample.pdf') && pdf.every(h => h.endsWith('.pdf')), `glob: ${pdf}`);
    const one = hrefsOf(await find('/many/', 'file-?.txt'));
    assert.equal(one.length, 9, `? is one character: ${one}`);

    const re = hrefsOf(await find('/many/', 're:^file-1\\d\\.txt$'));
    assert.equal(re.length, 10, `regex: ${re}`);
});

test('search: best matches first', async () => {
    const hrefs = hrefsOf(await find('/', 'file'));
    // "file.txt" is the word plus an extension: before file-1.txt and friends
    assert.equal(hrefs[0], '/loop/file.txt', `ranking: ${hrefs.slice(0, 5)}`);
    // then names starting with the word, shorter ones first
    assert.ok(hrefs.slice(1, 10).every(h => /^\/many\/file-\d\.txt$/.test(h)), `ranking: ${hrefs.slice(0, 12)}`);
    // folders before files of the same rank
    const docs = hrefsOf(await find('/', 'docs'));
    assert.equal(docs[0], '/docs/', `ranking: ${docs}`);
});

test('search: scoped to the folder and below', async () => {
    const hrefs = hrefsOf(await find('/many/', 'file'));
    assert.equal(hrefs.length, 150);
    assert.ok(hrefs.every(h => h.startsWith('/many/')));
    const r = await find('/docs/', 'notes');
    assert.deepEqual(hrefsOf(r), ['/docs/notes.txt']);
});

test('search: results are capped and say so', async () => {
    const r = await find('/', 'e');
    assertJson(r, 'broad');
    assert.ok(hrefsOf(r).length <= 200, `${hrefsOf(r).length} results`);
    const all = hrefsOf(await find('/many/', 'txt'));
    assert.equal(all.length, 150);
});

test('search: hidden, unmanaged and h6ai entries never show up', async () => {
    for (const q of ['secret', 'index', 'h6ai', 'h5ai', 'options', 'self']) {
        const r = await find('/', q);
        assertJson(r, q);
        for (const h of hrefsOf(r)) {
            assert.ok(!/\/\.[^/]/.test(h), `${q}: hidden path ${h}`);
            assert.ok(!/\/_h[56]ai/.test(h), `${q}: ${h}`);
            assert.ok(!h.startsWith('/site/'), `${q}: inside an unmanaged folder: ${h}`);
            assert.ok(h === '/loop/self/' || !h.startsWith('/loop/self/'), `${q}: through a symlink: ${h}`);
        }
    }
    assert.ok(hrefsOf(await find('/', 'site')).includes('/site/'), 'the unmanaged folder itself is found');
});

test('search: oversized and invalid input is refused with 400', async () => {
    const long = await find('/', 'x'.repeat(1001));
    assert.equal(long.res.status, 400);
    assert.equal(long.json.err, 'ERR_ILLEGAL_PARAM');
    const many = await find('/', 'a b c d e f g h i');
    assert.equal(many.res.status, 400);
    const bad = await find('/', 're:(');
    assert.equal(bad.res.status, 400);
    for (const q of ['', '   ', '-only', '*']) {
        const r = await find('/', q);
        assertJson(r, JSON.stringify(q));
        assert.deepEqual(hrefsOf(r), [], `${JSON.stringify(q)} matches nothing`);
    }
});

// last in this file: it uses up the client's search allowance (docker/options.local.json: 120
// per 10 s), then waits it out
test('search: per-client rate limit answers 429 with Retry-After', async () => {
    let limited = null;
    for (let i = 0; i < 300 && !limited; i += 1) {
        const r = await find('/docs/', 'notes');
        if (r.res.status === 429) {
            limited = r;
        }
    }
    assert.ok(limited, 'no 429 after 300 searches');
    assert.equal(limited.json.err, 'ERR_RATE_LIMITED');
    assert.ok(Number(limited.res.headers['retry-after']) > 0, 'Retry-After header');
    await new Promise(resolve => setTimeout(resolve, (Number(limited.res.headers['retry-after']) + 1) * 1000));
    const after = await find('/docs/', 'notes');
    assert.equal(after.res.status, 200, 'allowed again after the window');
});

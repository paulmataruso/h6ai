// Functional smoke tests + basic API contract (S6 setup disclosure, S8 content type, S13, S18).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    api, get, request, href, lastSegment, parseJson, API_PATH,
    SEEDED_FOLDERS, UNICODE_CONTENT
} from './lib.mjs';

const items = async folder => {
    const {res, json} = await api({action: 'get', items: {href: folder, what: 1}});
    assert.equal(res.status, 200, `items ${folder}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    assert.ok(json && Array.isArray(json.items), `items ${folder}: no items array: ${res.text.slice(0, 200)}`);
    return json.items;
};

test('root listing shows seeded folders, hides dot-folders and _h6ai (S13: completes despite symlink loop + foldersize)', async () => {
    const started = Date.now();
    const list = await items('/');
    assert.ok(Date.now() - started < 15000, 'root listing took too long (symlink loop in folder size?)');
    const hrefs = new Set(list.map(i => i.href));
    for (const f of SEEDED_FOLDERS) {
        assert.ok(hrefs.has(`/${f}/`), `missing /${f}/ in root listing`);
    }
    assert.ok(!hrefs.has('/.hidden/'), '/.hidden/ must not be listed');
    assert.ok(![...hrefs].some(h => h.startsWith('/_h6ai')), '/_h6ai must not be listed');
    for (const i of list) {
        assert.equal(typeof i.href, 'string');
        assert.ok(i.href.startsWith('/'), `href not absolute: ${i.href}`);
    }
});

test('items have time and size; files sizes are numbers', async () => {
    const list = await items('/docs/');
    const notes = list.find(i => i.href === '/docs/notes.txt');
    assert.ok(notes, 'notes.txt listed');
    assert.equal(typeof notes.size, 'number');
    assert.ok(notes.time > 1e12, 'time is in milliseconds');
    assert.ok(!list.some(i => i.href.includes('_h6ai.header')), '_h6ai.* files are hidden');
});

test('unicode and special-character names round-trip through listing and file serving', async () => {
    const list = await items('/unicode/');
    const byName = new Map(list.filter(i => i.href.startsWith('/unicode/') && i.href !== '/unicode/')
        .map(i => [lastSegment(i.href), i.href]));
    for (const [name, content] of Object.entries(UNICODE_CONTENT)) {
        const h = byName.get(name);
        assert.ok(h, `"${name}" not listed (got ${[...byName.keys()].join(', ')})`);
        const res = await get(h);
        assert.equal(res.status, 200, `GET ${h} -> ${res.status}`);
        assert.equal(res.text, content, `content of ${name}`);
    }
    assert.ok(byName.has('Ordner mit Ümlaut'), 'unicode folder listed');
});

test('large folder lists all 150 files', async () => {
    const list = await items('/many/');
    assert.equal(list.filter(i => /^\/many\/file-\d+\.txt$/.test(i.href)).length, 150);
});

test('unmanaged folder (own index.html) is reported as unmanaged and served by the web server', async () => {
    const list = await items('/');
    const site = list.find(i => i.href === '/site/');
    assert.ok(site, '/site/ listed');
    assert.equal(site.managed, false);
    const res = await get('/site/');
    assert.equal(res.status, 200);
    assert.match(res.text, /Unmanaged site/);
});

test('unknown folder / file returns 404', async () => {
    assert.equal((await get('/does-not-exist/')).status, 404);
    assert.equal((await get('/docs/does-not-exist.txt')).status, 404);
});

test('S8: JSON body with Content-Type text/plain is not parsed as JSON', async () => {
    const {res, json} = await api({action: 'get', setup: true}, {contentType: 'text/plain'});
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text.slice(0, 200)}`);
    assert.equal(json && json.err, 'ERR_MISSING_PARAM');
});

test('unsupported action -> 400 ERR_UNSUPPORTED', async () => {
    const {res, json} = await api({action: 'delete_everything'});
    assert.equal(res.status, 400);
    assert.equal(json && json.err, 'ERR_UNSUPPORTED');
});

test('malformed JSON body -> JSON error, not a PHP error page', async () => {
    const res = await request('POST', API_PATH, {headers: {'Content-Type': 'application/json'}, body: '{"action": '});
    assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`);
    const json = parseJson(res);
    assert.ok(json && json.err, `expected JSON error, got: ${res.text.slice(0, 200)}`);
});

test('S6: guest setup exposes no server/PHP details; options never contain the passhash', async () => {
    const {res, json} = await api({action: 'get', setup: true, options: true, types: true, langs: true, theme: true});
    assert.equal(res.status, 200);
    const setup = json.setup;
    assert.equal(setup.AS_ADMIN, false);
    assert.ok(setup.USER === null || setup.USER === undefined, 'guest USER must be null');
    for (const key of ['PHP_VERSION', 'SERVER_VERSION', 'SERVER_NAME', 'VERSION', 'HAS_CMD_FFMPEG']) {
        assert.ok(!(key in setup), `guest setup leaks ${key}`);
    }
    assert.ok(setup.CSRF === undefined || setup.CSRF === null, 'guest gets a CSRF token');
    assert.ok(!('passhash' in json.options), 'options leak passhash');
    assert.ok(!JSON.stringify(json.options).includes('$2y$'), 'options leak a bcrypt hash');
    assert.equal(typeof json.types, 'object');
    assert.equal(typeof json.langs, 'object');
});

test('l10n: known language loads, unknown codes are ignored', async () => {
    const {json} = await api({action: 'get', l10n: ['de', '../../conf/options', 'xx']});
    assert.ok(json.l10n.de, 'de loaded');
    assert.equal(Object.keys(json.l10n).length, 1, `only "de" expected, got ${Object.keys(json.l10n)}`);
});

test('info page is served', async () => {
    for (const p of ['/_h6ai/public/index.php', '/_h6ai/public/']) {
        const res = await get(p);
        assert.equal(res.status, 200, `${p} -> ${res.status}`);
        assert.match(res.headers['content-type'] || '', /text\/html/);
    }
});

test('S18: requests without User-Agent still work (no PHP warnings / blank page)', async () => {
    const res = await request('POST', API_PATH, {
        headers: {'User-Agent': null, 'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'get', items: {href: '/', what: 1}})
    });
    assert.equal(res.status, 200);
    assert.ok(parseJson(res) && Array.isArray(parseJson(res).items), res.text.slice(0, 200));
    assert.ok(!/Warning|Notice|Deprecated|Fatal error/i.test(res.text));
});

test('every encoded seeded folder href resolves', async () => {
    for (const f of SEEDED_FOLDERS) {
        const res = await get(href(f + '/'));
        assert.ok([200].includes(res.status), `${f}: ${res.status}`);
    }
});

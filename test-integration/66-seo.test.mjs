// Search engine visibility: generated robots.txt and sitemap.xml, robots meta tag, and their
// interplay with folder permissions (protected folders never appear in the sitemap).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {get, adminSession, adminOp, supportsAdminOp, okJson, BASE, BROWSER_UA} from './lib.mjs';

let admin = null;
let hasSettings = false;
let originalSeo = null;

const locs = xml => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const pagePath = url => new URL(url).pathname;

before(async () => {
    admin = await adminSession();
    hasSettings = await supportsAdminOp(admin, 'settings.get');
    if (hasSettings) {
        const json = okJson(await adminOp(admin.jar, admin.csrf, 'settings.get'), 'settings.get');
        originalSeo = json.settings && json.settings.seo;
        // tests start from the documented default: indexing allowed
        okJson(await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {seo: {allowIndexing: true, sitemap: true}}}), 'settings.save');
    }
});

after(async () => {
    if (admin) {
        await adminOp(admin.jar, admin.csrf, 'rule.delete', {path: '/private/'});
        if (hasSettings && originalSeo) {
            await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {seo: originalSeo}});
        }
    }
});

test('robots.txt is generated: crawl everything public, never /_h6ai/, points to the sitemap', async () => {
    const res = await get('/robots.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.match(res.text, /^User-agent: \*$/m);
    assert.match(res.text, /^Disallow: \/_h6ai\/$/m);
    assert.doesNotMatch(res.text, /^Disallow: \/$/m, 'indexing allowed by default');
    const sitemap = /^Sitemap: (\S+)$/m.exec(res.text);
    assert.ok(sitemap, 'Sitemap line');
    assert.equal(sitemap[1], `${BASE.protocol}//${BASE.host}/sitemap.xml`);
});

test('sitemap.xml lists public folders and files with absolute URLs', async () => {
    const res = await get('/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /xml/);
    assert.match(res.text, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const urls = locs(res.text);
    assert.ok(urls.length > 20, `only ${urls.length} URLs`);
    for (const url of urls) {
        assert.ok(url.startsWith(`${BASE.protocol}//${BASE.host}/`), url);
    }
    const paths = urls.map(pagePath);
    for (const expected of ['/', '/docs/', '/docs/notes.txt', '/images/photo.jpg', '/team/notes.txt']) {
        assert.ok(paths.includes(expected), `missing ${expected}`);
    }
});

test('sitemap.xml never contains h6ai internals, hidden or out-of-root paths', async () => {
    const res = await get('/sitemap.xml');
    const paths = locs(res.text).map(pagePath).map(decodeURIComponent);
    for (const p of paths) {
        assert.ok(!p.startsWith('/_h6ai/'), p);
        assert.ok(!/\/\./.test(p), `hidden path ${p}`);
        assert.ok(!p.includes('..'), p);
        assert.ok(!/outside/i.test(p), p);
    }
    // XML must be well formed enough: special characters escaped
    assert.doesNotMatch(res.text.replace(/<\/?(urlset|url|loc|lastmod)[^>]*>|<\?xml[^>]*\?>/g, ''), /[<>]/);
});

test('sitemap.xml respects folder permissions', async () => {
    okJson(await adminOp(admin.jar, admin.csrf, 'rule.save', {rule: {path: '/private/', grants: {'*': 'none'}}}), 'rule.save');
    try {
        const res = await get('/sitemap.xml');
        const paths = locs(res.text).map(pagePath);
        assert.ok(paths.length > 0);
        assert.ok(!paths.some(p => p.startsWith('/private/')), 'protected folder in sitemap');
        assert.ok(paths.includes('/docs/'), 'public content still listed');
    } finally {
        okJson(await adminOp(admin.jar, admin.csrf, 'rule.delete', {path: '/private/'}), 'rule.delete');
    }
});

test('pages carry a robots meta tag matching the indexing setting', async t => {
    if (!hasSettings) {
        t.skip('backend pending: admin settings API (settings.get / settings.save)');
        return;
    }
    let page = await get('/docs/', {headers: {'User-Agent': BROWSER_UA}});
    assert.match(page.text, /<meta name="robots" content="index, follow"/);

    okJson(await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {seo: {allowIndexing: false}}}), 'settings.save off');
    const robots = await get('/robots.txt');
    assert.match(robots.text, /^Disallow: \/$/m, 'robots.txt blocks everything');
    page = await get('/docs/', {headers: {'User-Agent': BROWSER_UA}});
    assert.match(page.text, /<meta name="robots" content="noindex/);

    okJson(await adminOp(admin.jar, admin.csrf, 'settings.save', {settings: {seo: {allowIndexing: true}}}), 'settings.save on');
    page = await get('/docs/', {headers: {'User-Agent': BROWSER_UA}});
    assert.match(page.text, /<meta name="robots" content="index, follow"/);
});

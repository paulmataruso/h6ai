// Google integration managed in the admin UI: the admin pastes the snippet Google gives them
// (Search Console verification meta tag, gtag.js or Tag Manager code). The server only keeps the
// extracted ids - never the raw snippet - and renders its own, nonce'd tags plus a matching CSP.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {get, adminSession, adminOp, supportsAdminOp, okJson, BROWSER_UA} from './lib.mjs';

// real Search Console tokens are 43 chars of base64url
const TOKEN = 'Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd1';
const SNIPPET = [
    `<meta name="google-site-verification" content="${TOKEN}" />`,
    '<!-- Google tag (gtag.js) -->',
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST12345"></script>',
    '<script>',
    '  window.dataLayer = window.dataLayer || [];',
    '  function gtag(){dataLayer.push(arguments);}',
    '  gtag(\'js\', new Date());',
    '  gtag(\'config\', \'G-TEST12345\');',
    '</script>'
].join('\n');

const GTM_SNIPPET = [
    '<!-- Google Tag Manager -->',
    '<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({\'gtm.start\':',
    'new Date().getTime(),event:\'gtm.js\'});var f=d.getElementsByTagName(s)[0],',
    'j=d.createElement(s),dl=l!=\'dataLayer\'?\'&l=\'+l:\'\';j.async=true;j.src=',
    '\'https://www.googletagmanager.com/gtm.js?id=\'+i+dl;f.parentNode.insertBefore(j,f);',
    '})(window,document,\'script\',\'dataLayer\',\'GTM-ABC1234\');</script>',
    '<!-- End Google Tag Manager -->'
].join('\n');

let admin = null;
let hasSettings = false;
let original = null;

const settingsGet = async () => okJson(await adminOp(admin.jar, admin.csrf, 'settings.get'), 'settings.get').settings;
const settingsSave = settings => adminOp(admin.jar, admin.csrf, 'settings.save', {settings});
const page = () => get('/docs/', {headers: {'User-Agent': BROWSER_UA}});
const csp = res => Object.fromEntries((res.headers['content-security-policy'] || '').split(';')
    .map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([k, ...v]) => [k, v]));

const skipIfPending = t => {
    if (!hasSettings) {
        t.skip('backend pending: admin settings API (settings.get / settings.save)');
        return true;
    }
    return false;
};

before(async () => {
    admin = await adminSession();
    hasSettings = await supportsAdminOp(admin, 'settings.get');
    if (hasSettings) {
        original = await settingsGet();
    }
});

after(async () => {
    if (hasSettings && original) {
        const google = {...original.google};
        delete google.apiSecretSet;
        // clear what the tests set, then restore the previous values
        await settingsSave({google: {verification: '', measurementId: '', tagManagerId: '', apiSecret: ''}});
        await settingsSave({google, seo: original.seo, siteName: original.siteName});
    }
});

test('settings.get returns the documented structure', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const s = await settingsGet();
    assert.equal(typeof s.siteName, 'string');
    for (const key of ['verification', 'tagManagerId', 'measurementId', 'apiSecretSet', 'trackDownloads', 'serverSideDownloads', 'sendUserNames']) {
        assert.ok(key in s.google, `google.${key}`);
    }
    assert.equal(typeof s.google.apiSecretSet, 'boolean');
    assert.ok(!('apiSecret' in s.google), 'apiSecret is write-only');
    assert.ok('allowIndexing' in s.seo && 'sitemap' in s.seo);
    assert.ok('enabled' in s.activityLog && 'retentionDays' in s.activityLog);
});

test('settings API is admin only and needs the CSRF token', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const noCsrf = await adminOp(admin.jar, 'wrong-token', 'settings.get');
    assert.equal(noCsrf.res.status, 403);
    const guest = await adminOp({}, admin.csrf, 'settings.save', {settings: {siteName: 'pwned'}});
    assert.equal(guest.res.status, 403);
});

test('a pasted gtag snippet: ids are extracted, the raw snippet is not stored', async t => {
    if (skipIfPending(t)) {
        return;
    }
    const r = await settingsSave({google: {snippet: SNIPPET}});
    okJson(r, 'settings.save snippet');
    const s = await settingsGet();
    assert.equal(s.google.verification, TOKEN);
    assert.equal(s.google.measurementId, 'G-TEST12345');
    assert.ok(!JSON.stringify(s).includes('dataLayer'), 'raw snippet returned');
    assert.ok(!JSON.stringify(s).includes('snippet'), 'snippet key returned');
});

test('the page renders the verification tag and a nonce\'d gtag loader, CSP allows Google', async t => {
    if (skipIfPending(t)) {
        return;
    }
    okJson(await settingsSave({google: {snippet: SNIPPET}}), 'settings.save');
    const res = await page();
    assert.ok(res.text.includes(`<meta name="google-site-verification" content="${TOKEN}">`), 'verification meta tag');
    const loader = /<script[^>]*src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-TEST12345"[^>]*>/.exec(res.text);
    assert.ok(loader, 'gtag.js loader');
    const nonce = /nonce="([^"]+)"/.exec(loader[0]);
    assert.ok(nonce, 'loader has a nonce');
    const policy = csp(res);
    assert.ok(policy['script-src'].includes(`'nonce-${nonce[1]}'`), 'nonce in CSP');
    assert.ok(policy['script-src'].includes('https://www.googletagmanager.com'), 'script-src');
    assert.ok(policy['connect-src'].some(v => v === 'https://*.google-analytics.com'), `connect-src ${policy['connect-src']}`);
    // nothing of the pasted inline script is reflected verbatim
    assert.doesNotMatch(res.text, /function gtag\(\)\{dataLayer\.push\(arguments\);\}\n {2}gtag\('js'/);
});

test('a pasted Tag Manager snippet yields the GTM container id', async t => {
    if (skipIfPending(t)) {
        return;
    }
    okJson(await settingsSave({google: {snippet: GTM_SNIPPET}}), 'settings.save gtm');
    const s = await settingsGet();
    assert.equal(s.google.tagManagerId, 'GTM-ABC1234');
    const res = await page();
    assert.match(res.text, /googletagmanager\.com\/gtm\.js\?id=GTM-ABC1234|GTM-ABC1234/);
});

test('invalid ids are rejected (400) instead of being injected into the page', async t => {
    if (skipIfPending(t)) {
        return;
    }
    for (const google of [
        {measurementId: 'G-TEST"><script>alert(1)</script>'},
        {tagManagerId: 'GTM-<x>'},
        {verification: 'abc" onload="alert(1)'},
        {verification: 'short'},
        {measurementId: 'UA-1234-1 x'}
    ]) {
        const r = await settingsSave({google});
        assert.equal(r.res.status, 400, `${JSON.stringify(google)}: ${r.res.status}`);
    }
    const res = await page();
    assert.doesNotMatch(res.text, /alert\(1\)/);
});

test('the Measurement Protocol API secret is write-only', async t => {
    if (skipIfPending(t)) {
        return;
    }
    okJson(await settingsSave({google: {apiSecret: 'very-secret-value-123'}}), 'settings.save apiSecret');
    const s = await settingsGet();
    assert.equal(s.google.apiSecretSet, true);
    assert.ok(!JSON.stringify(s).includes('very-secret-value-123'));
    const res = await page();
    assert.ok(!res.text.includes('very-secret-value-123'), 'secret leaked into the page');
    okJson(await settingsSave({google: {apiSecret: ''}}), 'clear apiSecret');
    assert.equal((await settingsGet()).google.apiSecretSet, false);
});

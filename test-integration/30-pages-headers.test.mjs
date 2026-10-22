// HTML pages, fallback XSS (S4), sessions on page views (S7), security headers (S12, S16),
// private folder and server hardening.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api, get, request} from './lib.mjs';

const CURL_UA = 'curl/8.4.0';

test('S4: fallback mode escapes file and folder names', async () => {
    const res = await get('/xss/', {headers: {'User-Agent': CURL_UA}});
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/html/);
    const html = res.text;
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'raw <img onerror> from a file name in fallback HTML');
    assert.ok(!html.includes('<svg onload=alert(1)>'), 'raw <svg onload> from a folder name in fallback HTML');
    assert.ok(!html.includes('<b>bold'), 'raw <b> from a file name in fallback HTML');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped file name present');
    assert.ok(html.includes('&lt;svg onload=alert(1)&gt;'), 'escaped folder name present');
});

test('S4: fallback mode is used for text browsers and lists unicode names', async () => {
    for (const ua of ['curl/8.4.0', 'Lynx/2.9.0', 'w3m/0.5.3', 'Links (2.29; Linux)']) {
        const res = await get('/unicode/', {headers: {'User-Agent': ua}});
        assert.equal(res.status, 200, ua);
        assert.ok(res.text.includes('space name.txt'), `${ua}: fallback listing`);
    }
});

test('S7: page views and file downloads do not start a session', async () => {
    for (const [path, ua] of [['/images/', undefined], ['/xss/', CURL_UA], ['/docs/notes.txt', undefined], ['/', undefined]]) {
        const res = await get(path, ua ? {headers: {'User-Agent': ua}} : {});
        assert.ok(res.status === 200, `${path}: ${res.status}`);
        assert.deepEqual(res.setCookies, [], `${path} sets cookies: ${res.setCookies}`);
    }
});

test('S12: HTML pages send security headers and a CSP', async () => {
    for (const [path, ua] of [['/images/', undefined], ['/xss/', CURL_UA], ['/_h6ai/public/index.php', undefined]]) {
        const res = await get(path, ua ? {headers: {'User-Agent': ua}} : {});
        const h = res.headers;
        const csp = h['content-security-policy'] || '';
        assert.match(csp, /default-src 'self'/, `${path}: CSP default-src (${csp})`);
        assert.match(csp, /frame-ancestors/, `${path}: CSP frame-ancestors`);
        assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), `${path}: CSP allows inline scripts`);
        assert.equal((h['x-content-type-options'] || '').toLowerCase(), 'nosniff', `${path}: nosniff`);
        assert.ok(h['x-frame-options'], `${path}: X-Frame-Options`);
        assert.ok(h['referrer-policy'], `${path}: Referrer-Policy`);
        assert.ok(!h['x-powered-by'], `${path}: X-Powered-By leaks PHP`);
    }
});

test('S16: page does not load third-party fonts or Universal Analytics', async () => {
    const res = await get('/images/');
    assert.ok(!res.text.includes('fonts.googleapis.com'), 'Google Fonts referenced');
    assert.ok(!res.text.includes('google-analytics.com'), 'GA referenced');
    assert.ok(!res.text.includes('browsehappy.com'), 'dead browsehappy link');
});

test('S12: JSON API responses are nosniff + no-store', async () => {
    const {res} = await api({action: 'get', items: {href: '/', what: 1}});
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.equal((res.headers['x-content-type-options'] || '').toLowerCase(), 'nosniff');
    assert.match(res.headers['cache-control'] || '', /no-store/);
});

test('private folder and other _h6ai internals are never served', async () => {
    const paths = [
        '/_h6ai/private/conf/options.json',
        '/_h6ai/private/conf/options.local.json',
        '/_h6ai/private/conf/types.json',
        '/_h6ai/private/php/class-bootstrap.php',
        '/_h6ai/private/cache/',
        '/_h6ai/private/data/',
        '/_h6ai/private/data/auth.json',
        '/_h6ai/private/',
        '/_h6ai/README.md',
        '/_h6ai/%70rivate/conf/options.json',
        '/_h6ai/public/../private/conf/options.json',
        '/_h6ai/public/%2e%2e/private/conf/options.json',
        '/_H6AI/private/conf/options.json'
    ];
    for (const p of paths) {
        const res = await get(p);
        assert.ok([400, 401, 403, 404].includes(res.status), `${p} -> ${res.status}`);
        assert.ok(!res.text.includes('"passhash"') && !res.text.includes('<?php'), `${p} leaks content`);
    }
});

test('php-fpm status/ping are not reachable from outside', async () => {
    for (const p of ['/fpm-status', '/fpm-ping', '/fpm-status?full', '/_h6ai/public/index.php/fpm-ping']) {
        const res = await get(p);
        assert.ok(!/pong|accepted conn|process manager/.test(res.text), `${p} exposes php-fpm (${res.status})`);
    }
});

test('PHP files in the share are served as data, never executed', async () => {
    const res = await get('/docs/not-executed.php');
    assert.ok(res.status === 200, `status ${res.status}`);
    assert.ok(res.text.includes('<?php'), 'source should be served verbatim');
    assert.ok(!/text\/html/.test(res.headers['content-type'] || ''), 'must not be served as HTML');
});

test('directory without trailing slash redirects with a relative Location', async () => {
    const res = await get('/images');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/images/');
});

test('server does not advertise its version', async () => {
    const res = await get('/images/');
    assert.ok(!/\d/.test(res.headers.server || ''), `Server header: ${res.headers.server}`);
});

test('TRACE and other odd methods are not reflected', async () => {
    const res = await request('TRACE', '/', {headers: {'X-Probe': 'reflect-me'}});
    assert.ok(!res.text.includes('reflect-me'));
});

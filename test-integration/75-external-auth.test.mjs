// External sign-in (auth.external): the external user goes in the HTML page, not the API
// response, and client-supplied headers cannot fake it.
//
// Tests against the main server (port 80 / H6AI_URL, feature on but no FastCGI param set)
// AND the test-ext-auth server (port 8688 / H6AI_EXT_URL, nginx sets H6AI_EXTERNAL_USER
// from the X-Test-Ext-User request header). See docker/nginx/test-ext-auth.conf.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {get, api, apiAs, request, login, getSetup, ADMIN_USER, ADMIN_PASS, BASE} from './lib.mjs';

// The external-auth test server: same container, port 8688.
const EXT_PORT = process.env.H6AI_EXT_PORT || '8688';
const EXT_BASE = new URL(BASE);
EXT_BASE.port = EXT_PORT;
const EXT_URL = EXT_BASE.origin;

const extGet = (path, {headers = {}, ...opts} = {}) =>
    request('GET', new URL(path, EXT_URL).href, {headers, ...opts});

const extApi = async (body, {headers = {}, ...opts} = {}) => {
    const res = await request('POST', new URL('/_h6ai/public/index.php', EXT_URL).href, {
        headers: {'Content-Type': 'application/json', Origin: EXT_URL, ...headers},
        body: JSON.stringify(body),
        ...opts
    });
    let json;
    try { json = JSON.parse(res.text); } catch { json = undefined; }
    return {res, json};
};

// --- feature off on the main server (no FastCGI param) ----------------------------------------

test('external user is absent from the GET page on main server (no FastCGI param)', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('__h6ai_ext'), 'page should not contain __h6ai_ext without FastCGI param');
});

test('external user is absent from the API get response', async () => {
    const {res, json} = await api({action: 'get', setup: true});
    assert.equal(res.status, 200);
    assert.ok(json.setup, 'setup should be present');
    assert.ok(!('EXTERNAL_USER' in json.setup), 'setup.EXTERNAL_USER should not be in API response');
    assert.ok(!('external_user' in json.setup), 'setup.external_user should not be in API response');
    assert.ok(!JSON.stringify(json).includes('__h6ai_ext'), 'API response should not contain __h6ai_ext');
});

test('a client-supplied H6AI-External-User header does not create an external user on main server', async () => {
    const res = await get('/', {
        headers: {
            'H6AI-External-User': 'evil-injected',
            'H6AI-External-Auth': 'session'
        }
    });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('evil-injected'), 'client-supplied external user header must not appear');
    assert.ok(!res.text.includes('__h6ai_ext'), 'no ext data without FastCGI param');
});

// --- feature on (test-ext-auth server, port 8688) ---------------------------------------------

test('ext server: page contains __h6ai_ext with name/auth/logoutUrl', async () => {
    const res = await extGet('/', {
        headers: {'X-Test-Ext-User': 'testuser', 'X-Test-Ext-Auth': 'session'}
    });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('__h6ai_ext'), 'page should contain __h6ai_ext');
    const match = res.text.match(/window\.__h6ai_ext\s*=\s*(\{[^<]+\})\s*;/);
    assert.ok(match, '__h6ai_ext should be a JSON object in a script tag');
    const ext = JSON.parse(match[1]);
    assert.equal(ext.name, 'testuser');
    assert.equal(ext.auth, 'session');
    assert.equal(ext.logoutUrl, '/.logout');
});

test('ext server: basic auth type is passed through', async () => {
    const res = await extGet('/', {
        headers: {'X-Test-Ext-User': 'basicuser', 'X-Test-Ext-Auth': 'basic'}
    });
    assert.equal(res.status, 200);
    const match = res.text.match(/window\.__h6ai_ext\s*=\s*(\{[^<]+\})\s*;/);
    assert.ok(match);
    const ext = JSON.parse(match[1]);
    assert.equal(ext.name, 'basicuser');
    assert.equal(ext.auth, 'basic');
});

test('ext server: no user header → no __h6ai_ext (feature on but nobody signed in)', async () => {
    const res = await extGet('/');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('__h6ai_ext'), 'no ext data when no user is signed in');
});

test('ext server: client H6AI-External-User header does not override or create user', async () => {
    // Without X-Test-Ext-User (which nginx maps to the FastCGI param), a client sending
    // H6AI-External-User directly should not produce an external user.
    const res = await extGet('/', {
        headers: {'H6AI-External-User': 'evil-injected'}
    });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('evil-injected'));
    assert.ok(!res.text.includes('__h6ai_ext'));
});

test('ext server: name with </script>, quotes and < is emitted safely', async () => {
    const nasty = '</script><img src=x onerror=alert(1)>';
    const res = await extGet('/', {
        headers: {'X-Test-Ext-User': nasty}
    });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('__h6ai_ext'), 'ext data should be present');
    // JSON_HEX_TAG encodes < as <: the literal </script> must NOT appear
    assert.ok(!res.text.includes('</script><img'), 'raw </script> must not appear in the page');
    // The name should be recoverable from the encoded JSON
    const match = res.text.match(/window\.__h6ai_ext\s*=\s*(\{[^;]+\})\s*;/);
    assert.ok(match);
    const ext = JSON.parse(match[1]);
    assert.equal(ext.name, nasty);
});

test('ext server: API get response never contains external user', async () => {
    const {res, json} = await extApi(
        {action: 'get', setup: true},
        {headers: {'X-Test-Ext-User': 'testuser'}}
    );
    assert.equal(res.status, 200);
    assert.ok(json.setup);
    const str = JSON.stringify(json);
    assert.ok(!str.includes('__h6ai_ext'));
    assert.ok(!str.includes('external_user'));
    assert.ok(!str.includes('EXTERNAL_USER'));
});

test('ext server: h6ai session takes precedence over external user', async () => {
    const {jar} = await login(ADMIN_USER, ADMIN_PASS);
    const {setup} = await getSetup(jar);
    assert.ok(setup.USER, 'should have a user');
    assert.equal(setup.USER.name, ADMIN_USER);
    assert.equal(setup.USER.isAdmin, true);
    assert.ok(!('EXTERNAL_USER' in setup));
    await apiAs(jar, {action: 'logout', csrf: setup.CSRF});
});

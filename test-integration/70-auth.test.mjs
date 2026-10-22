// Login, session hardening and CSRF/origin checks (S6, S7, S8).
// Performs exactly ONE failed login so the rate limiter (90-ratelimit) is not tripped early.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    api, apiAs, login, getSetup, parseSetCookie, ORIGIN, ADMIN_USER, ADMIN_PASS
} from './lib.mjs';

const SESSION_NAME_HINT = /sess|h6ai/i;

const sessionCookieFrom = res => res.setCookies.map(parseSetCookie)
    .filter(c => c.value && c.value !== 'deleted')
    .sort((a, b) => Number(SESSION_NAME_HINT.test(b.name)) - Number(SESSION_NAME_HINT.test(a.name)))[0];

test('S8: login from a foreign Origin is refused', async () => {
    const {res, json} = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS},
        {headers: {Origin: 'https://evil.example'}});
    assert.equal(res.status, 403, res.text.slice(0, 200));
    assert.equal(json && json.err, 'ERR_FORBIDDEN');
    assert.ok(!res.setCookies.length || !json.asAdmin);
});

test('S8: login flagged cross-site by Sec-Fetch-Site is refused', async () => {
    const {res, json} = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS},
        {headers: {Origin: undefined, 'Sec-Fetch-Site': 'cross-site'}});
    assert.equal(res.status, 403, res.text.slice(0, 200));
    assert.equal(json && json.err, 'ERR_FORBIDDEN');
});

test('S8: login with a text/plain body (simple CORS request) is not processed', async () => {
    const {res, json} = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {contentType: 'text/plain'});
    assert.equal(res.status, 400);
    assert.ok(json && json.err);
    assert.ok(!json.asAdmin);
});

test('S6: wrong password is rejected', async () => {
    const {res, json} = await login(ADMIN_USER, 'definitely-wrong');
    assert.ok(res.status < 500);
    assert.ok(json, res.text.slice(0, 200));
    assert.notEqual(json.asAdmin, true);
    assert.ok(!json.user, `user set after failed login: ${JSON.stringify(json.user)}`);
});

test('S6/S7: successful login regenerates the session id and hardens the cookie', async () => {
    // Learn the session cookie name from a real login, then log out again.
    const probe = await login(ADMIN_USER, ADMIN_PASS);
    assert.equal(probe.res.status, 200, probe.res.text.slice(0, 200));
    assert.equal(probe.json.asAdmin, true);
    const learned = sessionCookieFrom(probe.res);
    assert.ok(learned, `no session cookie set on login: ${probe.res.setCookies}`);
    await apiAs(probe.jar, {action: 'logout'});

    // Session fixation: present an attacker-chosen id, log in, expect a different id.
    const fixed = 'attackerfixed0123456789abcdefghij';
    const jar = {[learned.name]: fixed};
    const {res, json} = await login(ADMIN_USER, ADMIN_PASS, jar);
    assert.equal(res.status, 200);
    assert.equal(json.asAdmin, true);
    assert.equal(json.user, ADMIN_USER);
    const cookie = res.setCookies.map(parseSetCookie).find(c => c.name === learned.name && c.value);
    assert.ok(cookie, `login did not (re)issue ${learned.name}`);
    assert.notEqual(cookie.value, fixed, 'session id was not regenerated (session fixation)');
    assert.ok(cookie.flags.httponly, `HttpOnly missing: ${JSON.stringify(cookie.flags)}`);
    assert.match(String(cookie.flags.samesite || ''), /^(strict|lax)$/i, `SameSite missing: ${JSON.stringify(cookie.flags)}`);
    assert.equal(cookie.flags.path || '/', '/');
    if (ORIGIN.startsWith('https:')) {
        assert.ok(cookie.flags.secure, 'Secure flag missing on HTTPS');
    }

    // The new session is authenticated, the fixated one is not.
    const me = await getSetup(jar);
    assert.equal(me.setup.AS_ADMIN, true);
    assert.equal(me.setup.USER && me.setup.USER.name, ADMIN_USER);
    assert.equal(me.setup.USER.isAdmin, true);
    assert.equal(typeof me.setup.CSRF, 'string');
    assert.ok(me.setup.CSRF.length >= 16, 'CSRF token too short');

    const attacker = await getSetup({[learned.name]: fixed});
    assert.ok(!attacker.setup.USER, 'fixated session id is authenticated');
    assert.equal(attacker.setup.AS_ADMIN, false);

    // Logout ends the session.
    const out = await apiAs(jar, {action: 'logout', csrf: me.setup.CSRF});
    assert.equal(out.res.status, 200);
    assert.notEqual(out.json.asAdmin, true);
    const after = await getSetup(jar);
    assert.ok(!after.setup.USER, 'still logged in after logout');
});

test('S6: admin-only setup details are visible after login', async () => {
    const {jar} = await login(ADMIN_USER, ADMIN_PASS);
    const {setup} = await getSetup(jar);
    assert.equal(setup.AS_ADMIN, true);
    assert.ok('PHP_VERSION' in setup, 'admin sees environment checks');
    await apiAs(jar, {action: 'logout', csrf: setup.CSRF});
});

test('S8: a logged-in session cannot be driven cross-site', async () => {
    const {jar} = await login(ADMIN_USER, ADMIN_PASS);
    const {setup} = await getSetup(jar);
    const {res, json} = await apiAs(jar, {action: 'admin', op: 'list', csrf: setup.CSRF},
        {headers: {Origin: 'https://evil.example'}});
    assert.equal(res.status, 403, res.text.slice(0, 200));
    assert.equal(json && json.err, 'ERR_FORBIDDEN');
    await apiAs(jar, {action: 'logout', csrf: setup.CSRF});
});

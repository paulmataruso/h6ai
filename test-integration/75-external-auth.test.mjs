// External sign-in (auth.external): the external user goes in the HTML page, not the API
// response, and client-supplied headers cannot fake it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {get, api, apiAs, login, getSetup, ADMIN_USER, ADMIN_PASS} from './lib.mjs';

test('external user is absent from the GET page when auth.external is off (default)', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('__h6ai_ext'), 'page should not contain __h6ai_ext when disabled');
});

test('external user is absent from the API get response', async () => {
    const {res, json} = await api({action: 'get', setup: true});
    assert.equal(res.status, 200);
    assert.ok(json.setup, 'setup should be present');
    assert.ok(!('EXTERNAL_USER' in json.setup), 'setup.EXTERNAL_USER should not be in API response');
    assert.ok(!('external_user' in json.setup), 'setup.external_user should not be in API response');
    assert.ok(!JSON.stringify(json).includes('__h6ai_ext'), 'API response should not contain __h6ai_ext');
});

test('a client-supplied HTTP_H6AI_EXTERNAL_USER header does not appear in the page', async () => {
    // A client sending an H6AI-External-User header: nginx turns it into HTTP_H6AI_EXTERNAL_USER
    // in $_SERVER. The PHP code reads H6AI_EXTERNAL_USER (the FastCGI param), not HTTP_*.
    const res = await get('/', {
        headers: {
            'H6AI-External-User': 'evil-injected',
            'H6AI-External-Auth': 'session'
        }
    });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('evil-injected'), 'client-supplied external user header must not appear in page');
    assert.ok(!res.text.includes('__h6ai_ext'), 'no ext data when option is off');
});

test('a client-supplied header does not appear in the API response either', async () => {
    const {res, json} = await api(
        {action: 'get', setup: true},
        {headers: {'H6AI-External-User': 'evil-injected'}}
    );
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(json).includes('evil-injected'));
});

test('h6ai session takes precedence: logged-in user sees own account, not external', async () => {
    const {jar} = await login(ADMIN_USER, ADMIN_PASS);
    const {setup} = await getSetup(jar);
    assert.ok(setup.USER, 'should have a user');
    assert.equal(setup.USER.name, ADMIN_USER);
    assert.equal(setup.USER.isAdmin, true);
    // Even if external user were somehow set, the h6ai session wins
    assert.ok(!('EXTERNAL_USER' in setup), 'external user should not appear alongside h6ai session');
    await apiAs(jar, {action: 'logout', csrf: setup.CSRF});
});

// First run without a shell (drop-in installs) and the browser-vouched same-origin check.
// The full first-run flow (no password yet) runs in test-native/dropin.sh; here the server has a
// password, so the setup hashing must be closed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api, errorOf, ORIGIN, ADMIN_USER, ADMIN_PASS} from './lib.mjs';

const loginWith = headers => api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {headers});

test('setup hashing is closed once a password or users exist', async () => {
    const {res} = await api({action: 'passhash', pass: 'some-password-1'}, {headers: {'Sec-Fetch-Site': 'same-origin'}});
    assert.equal(res.status, 403);
    assert.equal(errorOf(res), 'ERR_DISABLED');
});

test('setup hashing refuses cross-site requests', async () => {
    const {res} = await api({action: 'passhash', pass: 'some-password-1'}, {headers: {Origin: 'https://evil.example'}});
    assert.equal(res.status, 403);
});

test('Sec-Fetch-Site: same-origin vouches for a login whose Host lost its port', async () => {
    // what a browser sends behind fastcgi_params that pass $host instead of the Host header
    const {res, json} = await loginWith({Origin: 'http://elsewhere.example:8080', 'Sec-Fetch-Site': 'same-origin'});
    assert.equal(res.status, 200);
    assert.equal(json.user, ADMIN_USER);
});

test('cross-site requests are refused, whatever the Origin says', async () => {
    assert.equal((await loginWith({Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site'})).res.status, 403);
    assert.equal((await loginWith({Origin: ORIGIN, 'Sec-Fetch-Site': 'same-site'})).res.status, 403);
    assert.equal((await loginWith({Origin: 'https://evil.example'})).res.status, 403);
});

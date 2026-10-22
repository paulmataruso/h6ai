// Login rate limiting (S6). MUST run last: it locks this client out of logins for the limiter
// window (15 min). Re-running the suite needs a reset - see test-integration/README.md.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiAs, login, ADMIN_USER, ADMIN_PASS} from './lib.mjs';

test('S6: repeated failed logins are rate limited, and the lock also blocks the right password', async () => {
    let limitedAt = 0;
    for (let i = 1; i <= 12; i += 1) {
        const {res, json} = await login(ADMIN_USER, `wrong-${i}`);
        assert.ok(json, `attempt ${i}: non-JSON (HTTP ${res.status})`);
        assert.notEqual(json.asAdmin, true);
        if (res.status === 429) {
            assert.equal(json.err, 'ERR_RATE_LIMITED');
            limitedAt = i;
            break;
        }
    }
    assert.ok(limitedAt > 0, 'no 429 after 12 failed logins');
    assert.ok(limitedAt <= 6, `rate limit kicked in only after ${limitedAt} failures`);

    const right = await login(ADMIN_USER, ADMIN_PASS);
    assert.equal(right.res.status, 429, 'correct password accepted while locked out');
    assert.notEqual(right.json && right.json.asAdmin, true);
});

test('S6: the limiter cannot be bypassed with X-Forwarded-For / X-Real-IP', async () => {
    const jar = {};
    for (const headers of [{'X-Forwarded-For': '203.0.113.7'}, {'X-Real-IP': '203.0.113.8'}, {'Forwarded': 'for=203.0.113.9'}]) {
        const {res, json} = await apiAs(jar, {action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {headers});
        assert.equal(res.status, 429, `${JSON.stringify(headers)} bypassed the limiter`);
        assert.notEqual(json && json.asAdmin, true);
    }
});

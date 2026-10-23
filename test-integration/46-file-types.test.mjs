// The admin page's check that nginx hands requests for every file type to h6ai (GateProbe): the
// gate, or the drop-in file server, notes probe requests for files that don't exist. A regex
// location of the server block's own would answer some types without h6ai; none does here.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {get, api, adminSession, adminOp, apiAs, okJson} from './lib.mjs';

let admin = null;
const probe = op => adminOp(admin.jar, admin.csrf, op).then(r => okJson(r, op).probe);

before(async () => {
    admin = await adminSession();
});

after(async () => {
    await apiAs(admin.jar, {action: 'logout', csrf: admin.csrf});
});

test('every file type reaches h6ai', async () => {
    const start = await probe('probe.start');
    assert.equal(start.ok, true, 'probe file written');
    assert.match(start.href, /^\/h6ai-probe-[0-9a-f]{32}\.$/);
    assert.ok(start.exts.includes('jpg') && start.exts.includes('php') && start.exts.includes('mp4'));
    for (const ext of start.exts) {
        const res = await get(start.href + ext);
        assert.equal(res.status, 404, `${ext}: HTTP ${res.status}`);
    }
    const {seen} = await probe('probe.result');
    assert.deepEqual(start.exts.filter(ext => !seen.includes(ext)), [], 'types that never reached h6ai');
});

test('only the current token counts, and a result ends the probe', async () => {
    const start = await probe('probe.start');
    await get('/h6ai-probe-' + '0'.repeat(32) + '.jpg');
    await get(start.href + 'png');
    assert.deepEqual((await probe('probe.result')).seen, ['png']);
    await get(start.href + 'gif');
    assert.deepEqual((await probe('probe.result')).seen, [], 'noted after the probe ended');
});

test('probes are admin only', async () => {
    const res = await api({action: 'admin', op: 'probe.start', csrf: 'x'});
    assert.equal(res.res.status, 403);
});

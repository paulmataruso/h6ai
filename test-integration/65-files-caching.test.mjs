// Large files through the file gate: Range, ETag/304, compression and caching headers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {get, request, bigBytes, BIG_SIZE} from './lib.mjs';

const BIG = '/big/big.bin';

test('HEAD on a 64 MiB file: length, Accept-Ranges, ETag, no compression', async () => {
    const res = await request('HEAD', BIG, {headers: {'Accept-Encoding': 'gzip, br'}});
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers['content-length']), BIG_SIZE);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.ok(res.headers.etag, 'ETag present');
    assert.ok(res.headers['last-modified'], 'Last-Modified present');
    assert.ok(!res.headers['content-encoding'], `compressed: ${res.headers['content-encoding']}`);
});

test('Range request in the middle returns exactly the requested bytes', async () => {
    const start = 32 * 1024 * 1024 + 5;
    const end = start + 4099;
    const res = await get(BIG, {headers: {Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'gzip'}});
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], `bytes ${start}-${end}/${BIG_SIZE}`);
    assert.equal(res.body.length, end - start + 1);
    assert.ok(res.body.equals(bigBytes(start, end)), 'range content mismatch');
    assert.ok(!res.headers['content-encoding']);
});

test('suffix and open-ended ranges work', async () => {
    const tail = await get(BIG, {headers: {Range: 'bytes=-16'}});
    assert.equal(tail.status, 206);
    assert.ok(tail.body.equals(bigBytes(BIG_SIZE - 16, BIG_SIZE - 1)));

    const open = BIG_SIZE - 100;
    const rest = await get(BIG, {headers: {Range: `bytes=${open}-`}});
    assert.equal(rest.status, 206);
    assert.equal(rest.body.length, 100);
    assert.ok(rest.body.equals(bigBytes(open, BIG_SIZE - 1)));
});

test('unsatisfiable range -> 416', async () => {
    const res = await get(BIG, {headers: {Range: `bytes=${BIG_SIZE + 10}-${BIG_SIZE + 20}`}});
    assert.equal(res.status, 416);
});

test('If-None-Match with the current ETag -> 304', async () => {
    const head = await request('HEAD', BIG);
    const etag = head.headers.etag;
    assert.ok(etag);
    const res = await get(BIG, {headers: {'If-None-Match': etag}});
    assert.equal(res.status, 304);
    assert.equal(res.body.length, 0);

    const stale = await get(BIG, {headers: {'If-None-Match': '"not-the-etag"', Range: 'bytes=0-7'}});
    assert.equal(stale.status, 206);
    assert.ok(stale.body.equals(bigBytes(0, 7)));
});

test('full download of the big file streams completely', async () => {
    const res = await get(BIG, {timeout: 120000});
    assert.equal(res.status, 200);
    assert.equal(res.body.length, BIG_SIZE);
    assert.ok(res.body.subarray(BIG_SIZE - 8).equals(bigBytes(BIG_SIZE - 8, BIG_SIZE - 1)));
});

test('media is never gzipped; text assets are', async () => {
    const jpg = await get('/images/photo.jpg', {headers: {'Accept-Encoding': 'gzip'}});
    assert.equal(jpg.status, 200);
    assert.ok(!jpg.headers['content-encoding'], 'jpeg gzipped');

    const js = await get('/_h6ai/public/js/scripts.js', {headers: {'Accept-Encoding': 'gzip'}});
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-encoding'], 'gzip', 'scripts.js not gzipped');
});

test('h6ai static assets are immutable-cacheable', async () => {
    for (const p of ['/_h6ai/public/js/scripts.js', '/_h6ai/public/css/styles.css']) {
        const res = await request('HEAD', p);
        assert.equal(res.status, 200, p);
        const cc = res.headers['cache-control'] || '';
        assert.match(cc, /max-age=31536000/, `${p}: ${cc}`);
        assert.match(cc, /immutable/, `${p}: ${cc}`);
    }
});

test('directory listings are not cached as static content', async () => {
    const res = await get('/images/');
    assert.ok(!/immutable/.test(res.headers['cache-control'] || ''), res.headers['cache-control']);
});

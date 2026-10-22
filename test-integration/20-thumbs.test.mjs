// Thumbnail endpoint: path traversal / hidden files (S1, S2, S14), resource limits (S3).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api, get, thumb, jpegSize, adminSession} from './lib.mjs';

const MAX_DIM = 2048;

const expectNoThumb = async (t, why) => {
    const r = await thumb(t);
    assert.ok(!r.invalid, `${why}: response is not JSON (HTTP ${r.res.status}): ${r.res.text.slice(0, 200)}`);
    assert.ok(r.res.status < 500, `${why}: server error ${r.res.status}`);
    assert.ok(!r.url, `${why}: got a thumbnail URL ${r.url}`);
    return r;
};

const fetchThumb = async url => {
    const res = await get(url);
    assert.equal(res.status, 200, `GET ${url} -> ${res.status}`);
    assert.match(res.headers['content-type'] || '', /image\/jpeg/);
    const size = jpegSize(res.body);
    assert.ok(size, 'thumbnail is a JPEG');
    return {res, size};
};

test('valid image thumbnails work for jpg/png/gif/webp/avif and are served as JPEG', async () => {
    // AVIF needs a GD built with libavif (the Docker image; not e.g. Ubuntu 24.04's PHP)
    const {setup} = await adminSession();
    const names = ['photo.jpg', 'photo.png', 'photo.gif', 'photo.webp'];
    if (setup.HAS_PHP_AVIF) {
        names.push('photo.avif');
    } else {
        await expectNoThumb({type: 'img', href: '/images/photo.avif', width: 240, height: 180}, 'avif without GD support');
    }
    for (const name of names) {
        const r = await thumb({type: 'img', href: `/images/${name}`, width: 240, height: 180});
        assert.ok(r.url, `${name}: no thumbnail (${JSON.stringify(r.error || r.res.text.slice(0, 120))})`);
        const {size} = await fetchThumb(r.url);
        assert.deepEqual(size, {width: 240, height: 180}, `${name} thumb size`);
    }
});

test('thumbnail URLs are long-term cacheable static files', async () => {
    const r = await thumb({type: 'img', href: '/images/photo.jpg', width: 100, height: 100});
    assert.ok(r.url);
    assert.ok(r.url.startsWith('/_h6ai/public/cache/'), `thumb URL outside public cache: ${r.url}`);
    const {res} = await fetchThumb(r.url);
    assert.match(res.headers['cache-control'] || '', /max-age=31536000/);
});

test('S1: thumbnails never leak files outside the root or in hidden locations', async () => {
    const hrefs = [
        '/../outside/secret.jpg',
        '/%2e%2e/outside/secret.jpg',
        '/%2E%2E/outside/secret.jpg',
        '/images/../../outside/secret.jpg',
        '/images/%2e%2e/%2e%2e/outside/secret.jpg',
        '/images/..%2f..%2foutside/secret.jpg',
        '/.hidden/secret.jpg',
        '/visible/.secret.jpg',
        '/srv/outside/secret.jpg',
        '//srv/outside/secret.jpg',
        '/_h6ai/public/images/favicon/favicon-152.png',
        'images/photo.jpg',
        '/images/photo.jpg\u0000.png',
        '/images/photo.jpg%00.png'
    ];
    for (const h of hrefs) {
        await expectNoThumb({type: 'img', href: h, width: 100, height: 100}, `href ${JSON.stringify(h)}`);
    }
});

test('S2: type mismatch / non-media files are never handed to converters', async () => {
    await expectNoThumb({type: 'mov', href: '/docs/notes.txt', width: 100, height: 100}, 'mov on .txt');
    await expectNoThumb({type: 'doc', href: '/docs/notes.txt', width: 100, height: 100}, 'doc on .txt');
    await expectNoThumb({type: 'img', href: '/docs/notes.txt', width: 100, height: 100}, 'img on .txt');
    await expectNoThumb({type: 'evil', href: '/images/photo.jpg', width: 100, height: 100}, 'unknown type');
    await expectNoThumb({type: 'img', href: '/images/', width: 100, height: 100}, 'folder');
    await expectNoThumb({type: 'mov', href: '/../outside/secret.jpg', width: 100, height: 100}, 'mov traversal');
    await expectNoThumb({type: 'doc', href: '/%2e%2e/outside/secret.jpg', width: 100, height: 100}, 'doc traversal');
});

test('S3: oversized dimensions are rejected or clamped', async () => {
    for (const [width, height] of [[100000, 100000], [100000, 0], [5000, 5000]]) {
        const r = await thumb({type: 'img', href: '/images/photo.jpg', width, height});
        assert.ok(!r.invalid, `${width}x${height}: non-JSON response (HTTP ${r.res.status})`);
        assert.ok(r.res.status < 500, `${width}x${height}: server error ${r.res.status}`);
        if (r.url) {
            const {size} = await fetchThumb(r.url);
            assert.ok(size.width <= MAX_DIM && size.height <= MAX_DIM, `${width}x${height} -> ${size.width}x${size.height}`);
        }
    }
});

test('S3: non-numeric / negative dimensions are rejected', async () => {
    for (const [width, height] of [['1/../../x', 100], [100, '../../evil'], [-100, 100], [100, -1], ['1e9', 10], [null, 100], [{}, 100]]) {
        await expectNoThumb({type: 'img', href: '/images/photo.jpg', width, height}, `dims ${JSON.stringify([width, height])}`);
    }
});

test('S3: decompression bomb (PNG claiming 30000x30000) is refused without a server error', async () => {
    const started = Date.now();
    await expectNoThumb({type: 'img', href: '/images/bomb.png', width: 100, height: 100}, 'bomb.png');
    await expectNoThumb({type: 'img', href: '/images/bomb.png', width: 1600, height: 0}, 'bomb.png sample');
    assert.ok(Date.now() - started < 10000);
});

test('S3: thumbnail requests are bounded in count', async () => {
    const many = Array.from({length: 500}, () => ({type: 'img', href: '/images/tiny.jpg', width: 32, height: 32}));
    const {res, json} = await api({action: 'get', thumbs: many});
    assert.ok(res.status < 500, `500 thumbs -> ${res.status}`);
    assert.ok(json, 'JSON response');
    if (!json.err) {
        assert.ok(Array.isArray(json.thumbs));
    }
});

// Video and document thumbnails need external tools; native installs may lack them (e.g. no
// ffmpeg on RHEL without RPM Fusion). The Docker image has all of them.
test('video thumbnails work for clips shorter than the seek offset', async t => {
    const {setup} = await adminSession();
    if (!setup.HAS_CMD_FFMPEG && !setup.HAS_CMD_AVCONV) {
        t.skip('no ffmpeg on this server');
        return;
    }
    for (const name of ['clip-5s.mp4', 'clip-20s.webm']) {
        const r = await thumb({type: 'mov', href: `/videos/${name}`, width: 240, height: 180});
        assert.ok(r.url, `${name}: no thumbnail`);
        await fetchThumb(r.url);
    }
});

test('PDF thumbnails work', async t => {
    const {setup} = await adminSession();
    if (!setup.HAS_CMD_GS && !setup.HAS_CMD_MAGICK && !setup.HAS_CMD_CONVERT && !setup.HAS_CMD_GM) {
        t.skip('no Ghostscript or ImageMagick on this server');
        return;
    }
    const r = await thumb({type: 'doc', href: '/docs/sample.pdf', width: 240, height: 180});
    assert.ok(r.url, 'sample.pdf: no thumbnail');
    await fetchThumb(r.url);
});

test('preview sample (height=0) keeps aspect ratio', async () => {
    const wide = await thumb({type: 'img', href: '/images/wide.jpg', width: 600, height: 0});
    assert.ok(wide.url);
    const {size} = await fetchThumb(wide.url);
    assert.equal(size.width, 600);
    assert.equal(size.height, 120);
});

test('EXIF orientation is honoured in samples', {todo: 'not part of the backend contract yet'}, async () => {
    const rot = await thumb({type: 'img', href: '/images/rotated-exif6.jpg', width: 600, height: 0});
    assert.ok(rot.url);
    const {size: rs} = await fetchThumb(rot.url);
    // 1200x800 pixels with EXIF orientation 6 is a portrait image
    assert.ok(rs.height > rs.width, `rotated-exif6.jpg sample is ${rs.width}x${rs.height}, expected portrait`);
});

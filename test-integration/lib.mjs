// Shared helpers for the h6ai integration / security regression suite.
// Talks plain HTTP via node:http so that every header (Origin, Cookie, Sec-Fetch-*, User-Agent)
// can be set exactly, and so multiple Set-Cookie headers are preserved.

import http from 'node:http';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const BASE = new URL(process.env.H6AI_URL || 'http://172.16.1.67:8687');
export const ORIGIN = BASE.origin;
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// --- names created by docker/seed.sh (keep in sync) ------------------------------------------
const repeat = (ch, n) => ch.repeat(n);
export const DEEP_D1 = `L1_${repeat('a', 97)}`;
export const DEEP_D2 = `L2_${repeat('b', 97)}`;
export const DEEP_F = `F_${repeat('c', 174)}.txt`;
export const DEEP_LONG_REL = `${DEEP_D1}/${DEEP_D2}/${DEEP_F}`;
export const UNICODE_NAMES = [
    'Ünïcödé — 日本語.txt',
    'space name.txt',
    '100%.txt',
    'a#b?.txt',
    'c++ & friends.txt'
];
export const SEEDED_FOLDERS = ['audio', 'big', 'deep', 'docs', 'empty', 'images', 'loop', 'many', 'site', 'team', 'unicode', 'videos', 'visible', 'xss'];
export const UNICODE_CONTENT = {
    'Ünïcödé — 日本語.txt': 'unicode\n',
    'space name.txt': 'space\n',
    '100%.txt': 'percent\n',
    'a#b?.txt': 'hash\n',
    'c++ & friends.txt': 'plus\n'
};
export const PRIVATE_SECRET = 'TOP-SECRET private content\n';
export const BIG_SIZE = 64 * 1024 * 1024;
// docker/seed-media.php bigfile: every 8-byte block holds its own offset as big-endian uint64.
export const bigBytes = (start, endInclusive) => {
    const out = Buffer.alloc(endInclusive - start + 1);
    for (let o = start; o <= endInclusive; o += 1) {
        const block = Math.floor(o / 8) * 8;
        const tmp = Buffer.alloc(8);
        tmp.writeBigUInt64BE(BigInt(block));
        out[o - start] = tmp[o - block];
    }
    return out;
};
export const ADMIN_USER = 'admin';
export const ADMIN_PASS = process.env.H6AI_ADMIN_PASS || 'admin-test';
export const XSS_FILE = '<img src=x onerror=alert(1)>.txt';
export const XSS_FOLDER = '"><svg onload=alert(1)>';

// --- raw HTTP -------------------------------------------------------------------------------
export const request = (method, path, {headers = {}, body = null, timeout = 30000} = {}) => {
    // Absolute paths are sent byte-for-byte (no WHATWG normalisation of "..", "%2e%2e", ...),
    // which matters for the traversal tests.
    const url = path.startsWith('/') ? new URL(BASE) : new URL(path, BASE);
    const rawPath = path.startsWith('/') ? path : url.pathname + url.search;
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    // a header set to undefined/null is removed (e.g. {Origin: undefined}, {'User-Agent': null})
    const hdrs = Object.fromEntries(Object.entries({'User-Agent': BROWSER_UA, ...headers})
        .filter(([, v]) => v !== undefined && v !== null));
    if (payload) {
        hdrs['Content-Length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const req = lib.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: rawPath,
            method,
            headers: hdrs,
            agent: false
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    setCookies: res.headers['set-cookie'] || [],
                    body: buf,
                    text: buf.toString('utf8'),
                    ms: Date.now() - started
                });
            });
        });
        req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout} ms: ${method} ${path}`)));
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
};

export const get = (path, opts = {}) => request('GET', path, opts);

export const parseJson = res => {
    try {
        return JSON.parse(res.text);
    } catch {
        return undefined;
    }
};

// POST a JSON API request to a folder URL (default "/"). Returns {res, json}.
export const api = async (body, {path = '/', headers = {}, contentType = 'application/json', timeout} = {}) => {
    const res = await request('POST', path, {
        headers: {'Content-Type': contentType, Origin: ORIGIN, ...headers},
        body: JSON.stringify(body),
        timeout
    });
    return {res, json: parseJson(res)};
};

// POST an application/x-www-form-urlencoded request (used by downloads).
export const form = (path, fields, {headers = {}, timeout = 60000} = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) {
            v.forEach((x, i) => params.append(`${k}[${i}]`, x));
        } else {
            params.append(k, v);
        }
    }
    return request('POST', path, {
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...headers},
        body: params.toString(),
        timeout
    });
};

// --- href helpers ----------------------------------------------------------------------------
// Encode each path segment the way h6ai does (rawurlencode).
export const href = (...segments) => {
    const trailing = segments.length && segments[segments.length - 1].endsWith('/');
    const parts = segments.join('/').split('/').filter(Boolean).map(s => encodeURIComponent(s));
    return '/' + parts.join('/') + (trailing ? '/' : '');
};

export const lastSegment = h => {
    const parts = h.replace(/\/$/, '').split('/');
    return decodeURIComponent(parts[parts.length - 1]);
};

// --- cookies ---------------------------------------------------------------------------------
export const parseSetCookie = sc => {
    const [pair, ...attrs] = sc.split(';').map(s => s.trim());
    const eq = pair.indexOf('=');
    const flags = {};
    for (const a of attrs) {
        const i = a.indexOf('=');
        flags[(i < 0 ? a : a.slice(0, i)).toLowerCase()] = i < 0 ? true : a.slice(i + 1);
    }
    return {name: pair.slice(0, eq), value: pair.slice(eq + 1), flags};
};

// Session cookies that actually set a value (ignore deletions).
export const sessionCookies = res => res.setCookies
    .map(parseSetCookie)
    .filter(c => c.value && c.value !== 'deleted' && !/expires=thu, 01 jan 1970/i.test(JSON.stringify(c.flags)));

// --- sessions --------------------------------------------------------------------------------
// A tiny cookie jar: {name: value}. Set-Cookie deletions remove the entry.
export const updateJar = (jar, res) => {
    for (const sc of res.setCookies) {
        const c = parseSetCookie(sc);
        const expired = c.flags.expires && Date.parse(c.flags.expires) < Date.now();
        if (!c.value || c.value === 'deleted' || expired || c.flags['max-age'] === '0') {
            delete jar[c.name];
        } else {
            jar[c.name] = c.value;
        }
    }
    return jar;
};
export const cookieHeader = jar => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
export const withJar = (jar, headers = {}) => (jar && Object.keys(jar).length ? {...headers, Cookie: cookieHeader(jar)} : headers);

// API call carrying a cookie jar (updated in place from the response).
export const apiAs = async (jar, body, opts = {}) => {
    const r = await api(body, {...opts, headers: withJar(jar, opts.headers)});
    if (jar) {
        updateJar(jar, r.res);
    }
    return r;
};

export const login = async (user, pass, jar = {}) => {
    const r = await apiAs(jar, {action: 'login', user, pass});
    return {...r, jar};
};

export const getSetup = async jar => {
    const {res, json} = await apiAs(jar, {action: 'get', setup: true});
    return {res, json, setup: json && json.setup};
};

// Admin operation; csrf is sent as a JSON field.
export const adminOp = (jar, csrf, op, payload = {}, opts = {}) => apiAs(jar, {action: 'admin', op, csrf, ...payload}, opts);

// --- thumbnails ------------------------------------------------------------------------------
// Ask for one thumb. Returns {url} on success, {none: true} for null, {error} for an API error.
export const thumb = async (t, {path = '/', jar = null} = {}) => {
    const {res, json} = await apiAs(jar, {action: 'get', thumbs: [t]}, {path});
    if (!json) {
        return {invalid: true, res};
    }
    if (json.err) {
        return {error: json.err, res};
    }
    const v = json.thumbs ? json.thumbs[0] : undefined;
    if (typeof v === 'string' && v) {
        return {url: v, res};
    }
    return {none: true, res};
};

// Width/height of a JPEG from its SOFn marker.
export const jpegSize = buf => {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) {
        return null;
    }
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) {
            i += 1;
            continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
            return {height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7)};
        }
        i += 2 + len;
    }
    return null;
};

// --- archives --------------------------------------------------------------------------------
const withTempFile = (buf, name, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'h6ai-it-'));
    const file = join(dir, name);
    try {
        writeFileSync(file, buf);
        return fn(file);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
};

// List a tar archive's entries with GNU/bsd tar. Throws if tar rejects it.
export const tarList = buf => withTempFile(buf, 'a.tar', file =>
    execFileSync('tar', ['-tf', file], {stdio: ['ignore', 'pipe', 'pipe']}).toString('utf8')
        .split('\n').filter(Boolean).map(s => s.replace(/^\.\//, '')));

const hasUnzip = (() => {
    try {
        execFileSync('unzip', ['-v'], {stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
})();

// List a zip archive's entries. Uses unzip if available, else a minimal central-directory parse.
export const zipList = buf => {
    if (hasUnzip) {
        return withTempFile(buf, 'a.zip', file =>
            execFileSync('unzip', ['-Z1', file], {stdio: ['ignore', 'pipe', 'pipe']}).toString('utf8')
                .split('\n').filter(Boolean));
    }
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]));
    if (buf.readUInt32LE(0) !== 0x04034B50 || eocd < 0) {
        throw new Error('not a zip archive');
    }
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let i = 0; i < count; i += 1) {
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
        off += 46 + nameLen + extraLen + commentLen;
    }
    return names;
};

export const isTar = buf => buf.length >= 512 && buf.toString('latin1', 257, 262) === 'ustar';
export const isZip = buf => buf.length >= 4 && buf.readUInt32LE(0) === 0x04034B50;

// Assert helper: response is a JSON API error (not an archive / not HTML).
export const errorOf = res => {
    const json = parseJson(res);
    return json && typeof json.err === 'string' ? json.err : null;
};

// --- admin sessions & pending-feature detection ----------------------------------------------
// Bootstrap admin session ({jar, csrf, setup}). The bootstrap login only works while no
// enabled admin user exists - every test file cleans up the users it creates.
export const adminSession = async () => {
    const {res, json, jar} = await login(ADMIN_USER, ADMIN_PASS);
    if (res.status !== 200 || !json || json.asAdmin !== true) {
        throw new Error(`admin login failed: HTTP ${res.status} ${res.text.slice(0, 200)} (rate limited? see test-integration/README.md)`);
    }
    const {setup} = await getSetup(jar);
    return {jar, csrf: setup.CSRF, setup};
};

// True if the backend knows an admin op (ERR_UNSUPPORTED means "not implemented (yet)").
export const supportsAdminOp = async (admin, op, payload = {}) => {
    const {json} = await adminOp(admin.jar, admin.csrf, op, payload);
    return !(json && json.err === 'ERR_UNSUPPORTED');
};

// Expect a successful JSON API answer and return the parsed body.
export const okJson = (r, what) => {
    if (!r.json) {
        throw new Error(`${what}: non-JSON answer (HTTP ${r.res.status}) ${r.res.text.slice(0, 200)}`);
    }
    if (r.res.status !== 200 || r.json.err) {
        throw new Error(`${what}: HTTP ${r.res.status} ${r.json.err || ''} ${r.json.msg || ''}`);
    }
    return r.json;
};

// Files with "active" content in the seeded tree (CVE-2026-10961 sandbox tests).
export const ACTIVE_DOCS = ['/docs/page.html', '/docs/vector.svg'];

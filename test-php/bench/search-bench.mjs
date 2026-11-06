// Search benchmark (docs/SEARCH.md, section 6), no dependencies.
//
//   node search-bench.mjs latency URL old|new [repeats]
//     each query of QUERIES, one after the other on one connection: results, p50, max
//   node search-bench.mjs load URL old|new SECONDS SEARCHERS [FILE] [FOLDER]
//     SEARCHERS clients search in a loop (random queries, no think time, backing off on 503
//     and 429 like the browser) while 4 clients download FILE through the gate and 2 list
//     FOLDER; prints the latency of each. SEARCHERS=0 is the baseline. All clients share one
//     IP: turn the per-IP limit off on the server (search.rateLimit.max 0).
//
// "old" is h6ai 1.0.1 and earlier: it gets what that UI sent, the regular expression of
// parsePattern(text, advanced); "new" gets the text (q).
import http from 'node:http';

const [mode, base, flavour, ...rest] = process.argv.slice(2);
const BASE = new URL(base);
const API = '/_h6ai/public/index.php';

const QUERIES = [
    'ubuntu', 'ubuntu iso', 'img_2019', 'final report', '*.iso', 'cafe', 'mkv', 'x', 'ab',
    'S03E07', 'budget 2015', 'zzqqxx', 'notes -draft', '"meeting notes"', 'firmware 12.3', 'résumé'
];

// h6ai HEAD's client: util/misc.js parse_pattern(sequence, advanced = true)
// eslint-disable-next-line no-useless-escape -- verbatim from 1.0.1's util/misc.js
const esc = s => s.replace(/[\-\[\]{}()*+?.,\\$\^|#\s]/g, '\\$&');
const oldPattern = text => text.startsWith('re:') ? text.slice(3)
    : text.trim().split(/\s+/).map(part => part.split('').map(esc).join('.*?')).join('|');

const body = (q, href = '/') => flavour === 'old'
    ? {action: 'get', search: {href, pattern: oldPattern(q), ignorecase: true}}
    : {action: 'get', search: {href, q, ignorecase: true}};

const call = (agent, method, path, payload) => new Promise(resolve => {
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const started = process.hrtime.bigint();
    const req = http.request({hostname: BASE.hostname, port: BASE.port, path, method, agent,
        headers: data ? {'Content-Type': 'application/json', 'Content-Length': data.length, Origin: BASE.origin} : {}}, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6, text: Buffer.concat(chunks).toString()}));
    });
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve({status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6, text: String(err)}));
    req.end(data || undefined);
});

const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN;
const stats = times => {
    const s = [...times].sort((a, b) => a - b);
    return {n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: s[s.length - 1]};
};
const f = x => Number.isFinite(x) ? x.toFixed(x < 10 ? 1 : 0) : '-';

if (mode === 'latency') {
    const repeats = Number(rest[0] || 5);
    const agent = new http.Agent({keepAlive: true, maxSockets: 1});
    console.log(`| query | results | p50 ms | max ms | info |`);
    console.log(`|---|---:|---:|---:|---|`);
    for (const q of QUERIES) {
        const times = [];
        let last = null;
        for (let i = 0; i < repeats; i += 1) {
            const r = await call(agent, 'POST', API, body(q));
            times.push(r.ms);
            last = r;
        }
        let json = {};
        try {
            json = JSON.parse(last.text);
        } catch {
            // not JSON: the status column says why
        }
        const st = stats(times);
        const info = json.searchInfo ? Object.entries(json.searchInfo).filter(([, v]) => v).map(([k]) => k).join(' ') : (last.status !== 200 ? 'HTTP ' + last.status : '');
        console.log(`| \`${q}\` | ${Array.isArray(json.search) ? json.search.length : 'HTTP ' + last.status} | ${f(st.p50)} | ${f(st.max)} | ${info} |`);
    }
} else if (mode === 'load') {
    const seconds = Number(rest[0] || 30);
    const searchers = Number(rest[1] || 16);
    const file = rest[2] || '/bench/small.txt';
    const folder = rest[3] || '/bench/';
    const until = Date.now() + seconds * 1000;
    const res = {search: [], download: [], listing: []};
    const codes = {search: {}, download: {}, listing: {}};
    const loop = async (kind, fn) => {
        const agent = new http.Agent({keepAlive: true, maxSockets: 1});
        while (Date.now() < until) {
            const r = await fn(agent);
            res[kind].push(r.ms);
            codes[kind][r.status] = (codes[kind][r.status] || 0) + 1;
        }
    };
    // like the browser (ext/search.js): one search in flight, busy (503) or rate limited (429)
    // answers retried after growing, jittered pauses, at most 4 times. The time recorded is what
    // the user waits, pauses included; shed counts the 503/429 answers along the way.
    const shed = {503: 0, 429: 0};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const politeSearch = async agent => {
        const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
        const started = Date.now();
        for (let attempt = 0; ; attempt += 1) {
            const r = await call(agent, 'POST', API, body(q));
            if ((r.status === 503 || r.status === 429) && attempt < 4 && Date.now() < until) {
                shed[r.status] += 1;
                await sleep((r.status === 503 ? 500 : 3000) * Math.pow(2, attempt) * (0.75 + Math.random() / 2));
                continue;
            }
            return {...r, ms: Date.now() - started};
        }
    };
    const jobs = [];
    for (let i = 0; i < searchers; i += 1) {
        jobs.push(loop('search', politeSearch));
    }
    for (let i = 0; i < 4; i += 1) {
        jobs.push(loop('download', agent => call(agent, 'GET', file)));
    }
    for (let i = 0; i < 2; i += 1) {
        jobs.push(loop('listing', agent => call(agent, 'POST', API, {action: 'get', items: {href: folder, what: 1}})));
    }
    await Promise.all(jobs);
    for (const kind of ['download', 'listing', 'search']) {
        const st = stats(res[kind]);
        if (!st.n) {
            continue;
        }
        console.log(`${kind.padEnd(9)} n=${String(st.n).padStart(6)} rps=${(st.n / seconds).toFixed(1).padStart(7)} p50=${f(st.p50)} p95=${f(st.p95)} p99=${f(st.p99)} max=${f(st.max)} ms  status ${JSON.stringify(codes[kind])}`
            + (kind === 'search' ? `  shed ${JSON.stringify(shed)}` : ''));
    }
}

// Load generator for test-integration/bench.sh (no dependencies).
//   node bench-load.mjs latency <path> <n>                 POST items API n times, prints p50/p95/max ms
//   node bench-load.mjs rps <path> <seconds> <concurrency>  keep-alive GETs, prints requests/s and latency
//   node bench-load.mjs rule <add|del>                       add/remove a permission rule (enables the ACL)
import http from 'node:http';
import {BASE, ORIGIN, login, getSetup, adminOp} from './lib.mjs';

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const fmt = x => x.toFixed(1);

const post = (agent, path, body) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const started = process.hrtime.bigint();
    const req = http.request({
        hostname: BASE.hostname, port: BASE.port || 80, path, method: 'POST', agent,
        headers: {'Content-Type': 'application/json', 'Content-Length': payload.length, Origin: ORIGIN}
    }, res => {
        res.resume();
        res.on('end', () => resolve({status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6}));
    });
    req.on('error', reject);
    req.end(payload);
});

const getReq = (agent, path) => new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request({hostname: BASE.hostname, port: BASE.port || 80, path, method: 'GET', agent}, res => {
        res.resume();
        res.on('end', () => resolve({status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6}));
    });
    req.on('error', reject);
    req.end();
});

const [mode, ...args] = process.argv.slice(2);

if (mode === 'latency') {
    const [path, n = '50'] = args;
    const agent = new http.Agent({keepAlive: true, maxSockets: 1});
    await post(agent, path, {action: 'get', items: {href: path, what: 1}}); // warm up
    const times = [];
    for (let i = 0; i < Number(n); i += 1) {
        const r = await post(agent, path, {action: 'get', items: {href: path, what: 1}});
        if (r.status !== 200) {
            throw new Error(`HTTP ${r.status}`);
        }
        times.push(r.ms);
    }
    times.sort((a, b) => a - b);
    console.log(`p50=${fmt(pct(times, 0.5))}ms p95=${fmt(pct(times, 0.95))}ms max=${fmt(times[times.length - 1])}ms n=${times.length}`);
} else if (mode === 'rps') {
    const [path, seconds = '10', concurrency = '16'] = args;
    const agent = new http.Agent({keepAlive: true, maxSockets: Number(concurrency)});
    const until = Date.now() + Number(seconds) * 1000;
    const times = [];
    const statuses = {};
    const worker = async () => {
        while (Date.now() < until) {
            const r = await getReq(agent, path);
            statuses[r.status] = (statuses[r.status] || 0) + 1;
            times.push(r.ms);
        }
    };
    const started = Date.now();
    await Promise.all(Array.from({length: Number(concurrency)}, worker));
    const elapsed = (Date.now() - started) / 1000;
    times.sort((a, b) => a - b);
    console.log(`rps=${fmt(times.length / elapsed)} p50=${fmt(pct(times, 0.5))}ms p95=${fmt(pct(times, 0.95))}ms ` +
        `n=${times.length} c=${concurrency} statuses=${JSON.stringify(statuses)}`);
} else if (mode === 'rule') {
    const {jar, json} = await login('admin', process.env.H6AI_ADMIN_PASS || 'admin-test');
    if (!json || !json.asAdmin) {
        throw new Error('admin login failed (bootstrap admin needs no other admin user to exist)');
    }
    const {setup} = await getSetup(jar);
    const rule = {path: '/private/', grants: {'*': 'none'}};
    const r = args[0] === 'add'
        ? await adminOp(jar, setup.CSRF, 'rule.save', {rule})
        : await adminOp(jar, setup.CSRF, 'rule.delete', {path: rule.path});
    console.log(`rule ${args[0]}: HTTP ${r.res.status}`);
} else {
    console.error('usage: bench-load.mjs latency|rps|rule ...');
    process.exit(2);
}

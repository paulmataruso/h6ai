// The admin page's checks in a real browser, for test-native/dropin-custom.sh: signs in, opens
// System and compares check rows and banners with what the server block should produce. The
// checks run in the browser (fetch), so this is what an admin sees, basic auth and HTTP/3 included.
//
//   H6AI_URL=https://127.0.0.1 EXPECT='{"Fast downloads": "passed nginx", ...}' node dropin-admin.cjs
//     EXPECT   row label -> "<passed|failed|pending> <text the result contains>"
//     BANNERS  JSON list of regular expressions some banner must match
//     NO_BANNER JSON list of regular expressions no banner may match
//     BASIC    user:password for nginx's basic auth
//     QUIC     an SPKI hash: HTTP/3 only, with that self-signed certificate
//     SHOT     a path: a full-page screenshot of the System tab
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const env = (name, fallback) => (process.env[name] ? JSON.parse(process.env[name]) : fallback);
const url = process.env.H6AI_URL || 'https://127.0.0.1';
const failures = [];
const ok = msg => console.log(`[admin]   ok ${msg}`);
const fail = msg => {
    failures.push(msg);
    console.log(`[admin]   FAIL ${msg}`);
};

(async () => {
    const origin = new URL(url);
    const args = process.env.QUIC ? ['--enable-quic', `--origin-to-force-quic-on=${origin.hostname}:${origin.port || 443}`,
        `--ignore-certificate-errors-spki-list=${process.env.QUIC}`] : [];
    const browser = await chromium.launch({args});
    const [username, password] = (process.env.BASIC || ':').split(':');
    const ctx = await browser.newContext({ignoreHTTPSErrors: true, httpCredentials: process.env.BASIC ? {username, password} : undefined});
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto(url + '/_h6ai/public/');
    await page.fill('input[name=user]', 'admin');
    await page.fill('input[name=pass]', 'admin-test');
    await page.click('form.login-form button[type=submit]');
    await page.click('[data-tab=system]', {timeout: 15000});
    // every row has an answer, and the file type probe (the slowest) is done. Polled with
    // evaluate(): waitForFunction's polling evaluates strings, which the page's CSP refuses.
    const done = () => page.evaluate(() => {
        const results = [...document.querySelectorAll('ul.checks li .check-result')].map(e => e.textContent);
        const labels = [...document.querySelectorAll('ul.checks li .check-label')].map(e => e.textContent);
        return labels.includes('File types') && !results.includes('checking');
    }).catch(() => false);
    for (let waited = 0; !(await done()); waited += 250) {
        if (waited > 60000) {
            throw new Error('the checks never finished');
        }
        await page.waitForTimeout(250);
    }
    await page.waitForTimeout(500);

    // the first row of a label: "Private cache" is in the drop-in card and in the System card
    const rows = {};
    for (const [label, row] of await page.$$eval('ul.checks li', lis => lis.map(li => [
        li.querySelector('.check-label').textContent,
        {state: li.className, result: li.querySelector('.check-result').textContent}
    ]))) {
        rows[label] = rows[label] || row;
    }
    for (const [label, want] of Object.entries(env('EXPECT', {}))) {
        const [state, ...text] = want.split(' ');
        const row = rows[label];
        if (!row) {
            fail(`no row "${label}"`);
        } else if (row.state !== state || !row.result.includes(text.join(' '))) {
            fail(`${label}: ${row.state} "${row.result}", want ${state} "${text.join(' ')}"`);
        } else {
            ok(`${label}: ${row.state} "${row.result}"`);
        }
    }

    const banners = await page.$$eval('.banner', bs => bs.map(b => b.textContent));
    for (const re of env('BANNERS', [])) {
        if (banners.some(b => new RegExp(re).test(b))) {
            ok(`banner /${re}/`);
        } else {
            fail(`no banner /${re}/ among: ${JSON.stringify(banners)}`);
        }
    }
    for (const re of env('NO_BANNER', [])) {
        const hit = banners.find(b => new RegExp(re).test(b));
        if (hit) {
            fail(`unexpected banner: ${hit}`);
        }
    }

    if (process.env.QUIC) {
        const protocols = await page.evaluate(() => [...new Set(performance.getEntries().map(e => e.nextHopProtocol).filter(Boolean))]);
        if (protocols.length === 1 && protocols[0] === 'h3') {
            ok('every request went over HTTP/3');
        } else {
            fail(`protocols used: ${protocols.join(', ')}`);
        }
    }
    if (errors.length) {
        fail(`page errors: ${errors.join('; ')}`);
    }
    if (process.env.SHOT) {
        await page.setViewportSize({width: 1280, height: 900});
        await page.screenshot({path: process.env.SHOT, fullPage: true});
    }
    await browser.close();
    process.exit(failures.length ? 1 : 0);
})().catch(err => {
    console.log(`[admin]   FAIL ${err.message}`);
    process.exit(1);
});

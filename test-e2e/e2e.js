// End-to-end UI check against the running container. Run inside the Playwright image.
// Covers the visitor path (themes, rows, band, archive, preview), the admin (access, folder groups,
// anon accounts, appearance, anonymous mode) and what each kind of account can see afterwards.
const {chromium} = require('playwright');
const assert = require('assert');

const BASE = process.env.H6AI_URL || 'http://172.16.1.67:8687';
const SHOTS = process.env.SHOTS || '/w/shots';
const results = [];
const problems = [];

let current = null;
let failCount = 0;
const step = async (name, fn) => {
    try {
        await fn();
        results.push(`ok   ${name}`);
    } catch (err) {
        failCount += 1;
        results.push(`FAIL ${name}: ${err.message.split('\n')[0]} @ ${current && current.url()}`);
        if (current) {
            await current.screenshot({path: `${SHOTS}/fail-${failCount}.png`}).catch(() => {});
            await current.keyboard.press('Escape').catch(() => {});
        }
    }
};

// expected noise: the sanitised XSS payload <img src=x> 404s, and Chrome reports the scripts it
// blocked in sandboxed user documents (that's the CVE-2026-10961 protection working)
// and the admin page's drop-in checks ask for things that must answer 404
const EXPECTED = [/\/(docs|visible)\/x$/, /Blocked script execution .* sandboxed/, /status of 404/,
    /\/_h6ai\/private\//, /\/h6ai-route-check-\d+\/$/];

const watch = (page, label) => {
    page.on('response', r => {
        if (r.status() === 404 && !EXPECTED.some(re => re.test(r.url()))) {
            problems.push(`[${label}] 404 ${r.url()}`);
        }
    });
    page.on('pageerror', err => problems.push(`[${label}] pageerror: ${err.message}`));
    page.on('console', msg => {
        const text = msg.text();
        if (msg.type() === 'error' && !/Cross-Origin-Opener-Policy/i.test(text) && !/40[13]/.test(text)
            && !EXPECTED.some(re => re.test(text))) {
            problems.push(`[${label}] console: ${text}`);
        }
    });
    page.on('dialog', dialog => {
        problems.push(`[${label}] XSS: unexpected ${dialog.type()} dialog "${dialog.message()}"`);
        dialog.dismiss();
    });
};

const row = (page, name) => page.locator('#items .item', {has: page.locator(`.label:text-is("${name}")`)}).first();
const skin = page => page.getAttribute('html', 'data-skin');
// the settings drawer remembers whether it was open, so toggle by state, not blindly
const drawer = async (page, open) => {
    if (await page.isVisible('#sidebar') !== open) {
        await page.click('#sidebar-toggle');
    }
};

(async () => {
    const browser = await chromium.launch();
    const guestCtx = await browser.newContext({viewport: {width: 1440, height: 900}, acceptDownloads: true});
    const page = await guestCtx.newPage();
    watch(page, 'guest');
    current = page;

    // ---- visitor ---------------------------------------------------------------------
    await step('listing renders in the default dark theme', async () => {
        await page.goto(BASE + '/');
        await page.waitForSelector('#items .item');
        assert.equal(await skin(page), 'midnight');
        assert.equal(await page.getAttribute('meta[name=color-scheme]', 'content'), 'dark');
        assert.ok(await page.locator('#items .item').count() > 5);
        assert.equal(await page.getAttribute('#crumbbar .crumb >> nth=0', 'aria-label'), 'Home');
        await page.screenshot({path: `${SHOTS}/e2e-01-index.png`});
    });

    await step('visitor theme picker switches the skin and remembers it', async () => {
        await drawer(page, true);
        await page.click('#theme-settings .swatch[data-skin=ember]');
        assert.equal(await skin(page), 'ember');
        assert.equal(await page.getAttribute('#theme-settings .swatch[data-skin=ember]', 'aria-checked'), 'true');
        await page.reload();
        await page.waitForSelector('#items .item');
        assert.equal(await skin(page), 'ember', 'applied before paint after reload');
        await page.screenshot({path: `${SHOTS}/e2e-02-theme-ember.png`});
        await drawer(page, true);
        await page.click('#theme-settings .swatch[data-skin=midnight]');
        assert.equal(await skin(page), 'midnight');
        assert.equal(await page.evaluate(() => JSON.parse(window.localStorage.getItem('_h6ai') || '{}').skin || null), null,
            'site default stops overriding');
        await drawer(page, false);
    });

    await step('keyboard: arrows focus items, "/" opens the filter', async () => {
        await page.locator('#content').click({position: {x: 600, y: 700}});
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const focused = await page.evaluate(() => document.activeElement.closest('#items .item') !== null);
        assert.ok(focused, 'an item is focused');
        await page.keyboard.press('/');
        assert.ok(await page.evaluate(() => document.activeElement.matches('#filter input')));
        await page.keyboard.type('ima');
        await page.waitForTimeout(400);
        const labels = await page.locator('#items .item:not(.folder-parent) .label').allTextContents();
        assert.ok(labels.length >= 1 && labels.every(l => /i.*m.*a/i.test(l)), 'filtered: ' + labels.join(','));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    });

    await step('sort headers are buttons that announce their state', async () => {
        await page.focus('#items .header button.date');
        await page.keyboard.press('Space');
        assert.match(await page.textContent('#items .header button.date'), /sorted ascending/);
        await page.click('#items .header button.label');
        assert.match(await page.textContent('#items .header button.label'), /sorted (a|de)scending/);
        assert.equal((await page.textContent('#items .header button.date')).includes('sorted'), false);
    });

    await step('file row: download chip and inline band with resumable commands', async () => {
        await page.goto(BASE + '/big/');
        await page.waitForSelector('#items .item.file');
        // big.bin (64 MiB) is in every seeded tree; big-7g.bin only where the 7 GiB file was made
        const r = row(page, 'big.bin');
        assert.equal(await r.locator('a.dl').getAttribute('download'), '');
        assert.match(await r.locator('a.dl').getAttribute('aria-label'), /^Download big\.bin, /);
        await r.locator('a.main').click();
        await page.waitForSelector('#items .band .download-btn');
        assert.match(await page.getAttribute('.band .download-btn', 'href'), /\/big\/big\.bin$/);
        assert.match(await page.textContent('.band .download-btn'), /Download \d/);
        assert.ok(await page.evaluate(() => document.activeElement.classList.contains('download-btn')), 'focus on Download');
        const lines = await page.locator('.band-line code').allTextContents();
        assert.ok(lines.some(l => l.startsWith('curl -L -C - -O ')) && lines.some(l => l.startsWith('wget -c ')), lines.join(' | '));
        assert.equal(await page.locator('#items > .band').count(), 1);
        assert.equal(await page.locator('.band .band-inner[role=region]').count(), 1);
        await page.screenshot({path: `${SHOTS}/e2e-03-band.png`});
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.band').count(), 0);
        assert.ok(await page.evaluate(() => document.activeElement.matches('#items .item a.main')), 'focus back on the row');
    });

    await step('selection: archive button names the package, clear selection resets it', async () => {
        await page.goto(BASE + '/docs/');
        await page.waitForSelector('#items .item.file');
        await page.click('#items .item.file >> nth=0 >> .selector', {force: true});
        await page.click('#items .item.file >> nth=2 >> .selector', {force: true});
        assert.match(await page.textContent('#download'), /Download 2 items/);
        assert.ok(await page.isVisible('#clear-selection'));
        await page.screenshot({path: `${SHOTS}/e2e-04-selection.png`});
        await page.click('#clear-selection');
        assert.equal(await page.locator('#items .item.selected').count(), 0);
        assert.ok(await page.locator('#download').evaluate(el => el.classList.contains('hidden')));
    });

    await step('navigate into /images/ via fast browsing, icons view with thumbnails', async () => {
        await page.goto(BASE + '/');
        await page.waitForSelector('#items .item');
        await row(page, 'images').locator('a.main').click();
        await page.waitForURL(/\/images\/$/);
        await drawer(page, true);
        await page.click('#viewmode-icons');
        await page.waitForSelector('#items .item .icon.landscape img.thumb', {timeout: 15000});
        await page.waitForTimeout(800);
        await page.screenshot({path: `${SHOTS}/e2e-05-icons-thumbs.png`});
        await drawer(page, false);
    });

    await step('image preview opens, navigates and closes', async () => {
        await row(page, 'photo.jpg').locator('a.main').click();
        await page.waitForSelector('#pv-overlay:not(.hidden) #pv-content-img', {timeout: 10000});
        const before = Number((await page.innerText('#pv-bar-idx')).split('/')[0]);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(800);
        const after = Number((await page.innerText('#pv-bar-idx')).split('/')[0]);
        assert.equal(after, before + 1, `index ${before} -> ${after}`);
        await page.screenshot({path: `${SHOTS}/e2e-06-preview.png`});
        await page.keyboard.press('Escape');
        assert.ok(await page.locator('#pv-overlay').evaluate(el => el.classList.contains('hidden')));
    });

    await step('markdown preview and custom header are sanitized (no script runs)', async () => {
        await drawer(page, true);
        await page.click('#viewmode-details');
        await drawer(page, false);
        await page.goto(BASE + '/docs/');
        await page.waitForSelector('#items .item');
        await page.waitForSelector('#content-header:not(.hidden)', {timeout: 5000});
        assert.equal(await page.locator('#content-header script, #content-header [onerror]').count(), 0);
        await row(page, 'readme.md').locator('a.main').click();
        await page.waitForSelector('#pv-content-txt.markdown');
        assert.equal(await page.locator('#pv-content-txt script, #pv-content-txt [onerror], #pv-content-txt a[href^="javascript"]').count(), 0);
        await page.screenshot({path: `${SHOTS}/e2e-07-markdown.png`});
        await page.keyboard.press('Escape');
    });

    await step('CVE-2026-10961: user HTML/SVG in the share open without running script', async () => {
        await page.goto(BASE + '/docs/page.html');
        assert.equal(await page.textContent('#state'), 'script did not run (sandboxed)');
        await page.goto(BASE + '/docs/vector.svg');
        await page.waitForTimeout(500);
        // the dialog listener in watch() records any alert() as a problem
    });

    // ---- admin -----------------------------------------------------------------------
    const adminCtx = await browser.newContext({viewport: {width: 1280, height: 860}});
    const admin = await adminCtx.newPage();
    watch(admin, 'admin');
    current = admin;
    const accessView = async view => {
        await admin.click('.tab[data-tab=access]');
        await admin.click(`.subnav [data-view=${view}]`);
    };

    await step('admin: bootstrap login on the admin page', async () => {
        await admin.goto(BASE + '/_h6ai/public/');
        await admin.fill('input[name=user]', 'admin');
        await admin.fill('input[name=pass]', 'admin-test');
        await admin.click('button[type=submit]');
        await admin.waitForSelector('.tabs');
        assert.ok(await admin.locator('.banner.warn').isVisible(), 'bootstrap banner');
        assert.equal(await admin.getAttribute('#content', 'role'), 'main');
    });

    await step('admin: tabs follow the keyboard tabs pattern', async () => {
        await admin.focus('.tabs [role=tab][aria-selected=true]');
        await admin.keyboard.press('Home');
        await admin.keyboard.press('ArrowRight');
        assert.equal(await admin.evaluate(() => document.activeElement.dataset.tab), 'appearance');
        assert.equal(await admin.getAttribute('.tabs [data-tab=appearance]', 'aria-selected'), 'true');
        await admin.keyboard.press('Home');
        assert.equal(await admin.evaluate(() => document.activeElement.dataset.tab), 'access');
    });

    await step('admin: create user "bob"', async () => {
        await accessView('users');
        await admin.click('button:has-text("Add user")');
        await admin.fill('dialog input[name=name]', 'bob');
        await admin.fill('dialog input[name=password]', 'bob-password-1');
        await admin.click('dialog button[type=submit]');
        await admin.waitForSelector('table.data td strong:has-text("bob")');
        await admin.screenshot({path: `${SHOTS}/e2e-08-admin-users.png`});
    });

    await step('admin: add permission rule for /videos/ (everyone none, bob read)', async () => {
        await accessView('rules');
        await admin.click('button:has-text("Add rule")');
        await admin.waitForSelector('.picker-list button');
        await admin.click('.picker-list button:has-text("videos")');
        await admin.waitForSelector('dialog .picker-crumb:text-is("/videos/")');
        const rows = admin.locator('dialog .grant-row');
        await rows.nth(0).locator('select[name=level]').selectOption('none');
        await admin.click('dialog button:has-text("Add grant")');
        await rows.nth(1).locator('select[name=principal]').selectOption('user:bob');
        await rows.nth(1).locator('select[name=level]').selectOption('read');
        assert.equal(await rows.nth(1).locator('select[name=level]').getAttribute('aria-label'), 'Access level');
        await admin.screenshot({path: `${SHOTS}/e2e-09-admin-rule-dialog.png`});
        await admin.click('dialog button[type=submit]');
        await admin.waitForSelector('table.data code:has-text("/videos/")');
    });

    await step('admin: access checker explains the deciding rule', async () => {
        await admin.fill('.checker input[name=path]', '/videos/');
        await admin.selectOption('.checker select[name=principal]', '*');
        await admin.click('.checker button[type=submit]');
        await admin.waitForSelector('.checker-result');
        assert.match(await admin.textContent('.checker-result'), /none on \/videos\/: decided by the permission on \/videos\//);
        await admin.screenshot({path: `${SHOTS}/e2e-10-admin-checker.png`});
    });

    await step('admin: folder group "e2e-audio" and anon user "carol"', async () => {
        await accessView('groups');
        await admin.click('.card-head button:has-text("Add folder group")');
        await admin.fill('dialog input[name=name]', 'e2e-audio');
        await admin.fill('dialog input[name=description]', 'e2e test media');
        await admin.click('dialog .picker-list button:has-text("audio")');
        await admin.waitForSelector('dialog .picker-crumb:text-is("/audio/")');
        await admin.click('dialog button:has-text("Add /audio/")');
        await admin.click('dialog button[type=submit]');
        await admin.waitForSelector('table.data td strong:has-text("e2e-audio")');

        await accessView('users');
        await admin.click('button:has-text("Add user")');
        await admin.fill('dialog input[name=name]', 'carol');
        await admin.fill('dialog input[name=password]', 'carol-password-1');
        await admin.selectOption('dialog select[name=type]', 'anon');
        assert.ok(await admin.locator('dialog fieldset:has(legend:text-is("Roles"))').isHidden(), 'anon has no roles');
        await admin.click('dialog button:has-text("Add folder group")');
        await admin.selectOption('dialog .access-row select[name=level]', 'download');
        await admin.screenshot({path: `${SHOTS}/e2e-11-admin-anon-dialog.png`});
        await admin.click('dialog button[type=submit]');
        await admin.waitForSelector('table.data tr:has(strong:text-is("carol")) .chip:has-text("e2e-audio: download")');
    });

    await step('admin: system tab', async () => {
        await admin.click('.tab[data-tab=system]');
        await admin.waitForSelector('.checks li');
        assert.equal(await admin.locator('.checks li.failed').count(), 0, 'all system checks pass');
        await admin.screenshot({path: `${SHOTS}/e2e-12-admin-system.png`, fullPage: true});
    });

    current = page;
    await step('guest: /videos/ is denied with a login prompt, file URL is 401', async () => {
        await page.goto(BASE + '/videos/');
        await page.waitForSelector('#view-hint:not(.hidden) .denied-icon');
        assert.ok(await page.locator('#view-hint button:has-text("Log in")').isVisible());
        await page.screenshot({path: `${SHOTS}/e2e-13-guest-denied.png`});
        const resp = await page.request.get(BASE + '/videos/clip-5s.mp4');
        assert.equal(resp.status(), 401);
    });

    await step('bob logs in from the listing and can open /videos/', async () => {
        await page.click('#view-hint button:has-text("Log in")');
        await page.fill('#login-dialog input[name=user]', 'bob');
        await page.fill('#login-dialog input[name=pass]', 'bob-password-1');
        await page.screenshot({path: `${SHOTS}/e2e-14-login-dialog.png`});
        await Promise.all([page.waitForNavigation(), page.click('#login-dialog button[type=submit]')]);
        await page.waitForSelector('#account.avatar');
        await page.waitForSelector('#items .item.file');
        const resp = await page.request.get(BASE + '/videos/clip-5s.mp4', {headers: {Range: 'bytes=0-99'}});
        assert.equal(resp.status(), 206);
        await page.click('#account');
        await page.click('#account-menu .logout');
        await page.waitForSelector('#view-hint .denied-icon');
    });

    const carolCtx = await browser.newContext({viewport: {width: 1280, height: 800}});
    const carol = await carolCtx.newPage();
    watch(carol, 'carol');
    current = carol;
    await step('anon carol: sees only her folder group, downloads without previews', async () => {
        await carol.goto(BASE + '/');
        await carol.waitForSelector('#items .item');
        await carol.click('#account');
        await carol.fill('#login-dialog input[name=user]', 'carol');
        await carol.fill('#login-dialog input[name=pass]', 'carol-password-1');
        await Promise.all([carol.waitForNavigation(), carol.click('#login-dialog button[type=submit]')]);
        await carol.waitForSelector('#account.avatar');
        await carol.waitForSelector('#items .item.folder');
        const names = await carol.locator('#items .item:not(.folder-parent) .label').allTextContents();
        assert.deepEqual(names, ['audio']);
        await row(carol, 'audio').locator('a.main').click();
        await carol.waitForSelector('#items .item.file');
        await row(carol, 'tone.mp3').locator('a.main').click();
        await carol.waitForSelector('.band .download-btn');
        assert.ok(await carol.locator('#pv-overlay').evaluate(el => el.classList.contains('hidden')), 'no preview for anon');
        await carol.screenshot({path: `${SHOTS}/e2e-15-anon-band.png`});
        await carol.goto(BASE + '/videos/');
        await carol.waitForSelector('#view-hint .hint-actions a:has-text("Go to your folders")');
        assert.match(await carol.textContent('#view-hint p'), /only sees the folders that were shared with it/);
        assert.equal((await carol.request.get(BASE + '/videos/clip-5s.mp4')).status(), 403);
        await carol.click('#account');
        assert.equal(await carol.locator('#account-menu .menu-item:visible').count(), 1, 'anon menu: log out only');
    });

    current = admin;
    await step('admin: appearance sets the site theme and the click action', async () => {
        await admin.click('.tab[data-tab=appearance]');
        await admin.click('.theme-card[data-skin=deepsea] button:has-text("Set as site default")');
        await admin.waitForTimeout(400);
        await admin.check('input[name=clickAction][value=download]');
        await admin.click('form:has(input[name=clickAction]) button[type=submit]');
        await admin.waitForTimeout(400);
        await admin.screenshot({path: `${SHOTS}/e2e-16-admin-appearance.png`, fullPage: true});

        const fresh = await (await browser.newContext({viewport: {width: 1280, height: 800}})).newPage();
        watch(fresh, 'fresh');
        await fresh.goto(BASE + '/docs/');
        await fresh.waitForSelector('#items .item.file');
        assert.equal(await skin(fresh), 'deepsea');
        assert.equal(await row(fresh, 'readme.md').locator('a.main').getAttribute('download'), '', 'single click downloads');
        await fresh.close();

        await admin.reload();
        await admin.waitForSelector('.tabs');
        await admin.click('.tab[data-tab=appearance]');
        await admin.click('.theme-card[data-skin=midnight] button:has-text("Set as site default")');
        await admin.waitForTimeout(400);
        await admin.check('input[name=clickAction][value=expand]');
        await admin.click('form:has(input[name=clickAction]) button[type=submit]');
        await admin.waitForTimeout(400);
    });

    await step('admin: anonymous mode hides sign-in and excluded folders', async () => {
        await admin.reload();
        await admin.waitForSelector('.tabs');
        await accessView('visitors');
        await admin.click('button:has-text("Exclude a folder")');
        await admin.click('.picker-list button:has-text("team")');
        await admin.waitForSelector('dialog .picker-crumb:text-is("/team/")');
        await admin.click('dialog button[type=submit]');
        await admin.waitForSelector('table.data code:text-is("/team/")');
        await admin.check('input[name=anonymous][value="1"]');
        await admin.click('form:has(input[name=anonymous]) button[type=submit]');
        await admin.waitForTimeout(400);
        await admin.screenshot({path: `${SHOTS}/e2e-17-admin-visitors.png`, fullPage: true});

        const visitor = await (await browser.newContext({viewport: {width: 1280, height: 800}})).newPage();
        watch(visitor, 'visitor');
        await visitor.goto(BASE + '/');
        await visitor.waitForSelector('#items .item.folder');
        assert.equal(await visitor.locator('#account').count(), 0, 'no sign-in button');
        assert.equal(await row(visitor, 'team').count(), 0, 'excluded folder listed');
        assert.equal(await row(visitor, 'docs').count(), 1);
        await visitor.goto(BASE + '/team/');
        await visitor.waitForSelector('#view-hint:not(.hidden) .denied-icon');
        assert.match(await visitor.textContent('#view-hint'), /isn't available/);
        assert.equal(await visitor.locator('#view-hint button').count(), 0, 'no login offered');
        assert.equal((await visitor.request.get(BASE + '/team/notes.txt')).status(), 403);
        await visitor.close();

        await admin.check('input[name=anonymous][value="0"]');
        await admin.click('form:has(input[name=anonymous]) button[type=submit]');
        await admin.waitForTimeout(400);
        await admin.click('button[title="Show /team/ to visitors again"]');
        await admin.waitForSelector('table.data code:text-is("/team/")', {state: 'detached'});
    });

    await step('admin: cleanup rule, users and folder group', async () => {
        await admin.reload();
        await admin.waitForSelector('.tabs');
        await accessView('rules');
        await admin.click('button[title="Delete /videos/"]');
        await admin.click('dialog button[type=submit]');
        await admin.waitForSelector('text=No rules: everything is public.');
        await accessView('users');
        for (const name of ['bob', 'carol']) {
            await admin.click(`button[title="Delete ${name}"]`);
            await admin.click('dialog button[type=submit]');
            await admin.waitForSelector(`table.data td strong:text-is("${name}")`, {state: 'detached'});
        }
        await accessView('groups');
        await admin.click('button[title="Delete e2e-audio"]');
        await admin.click('dialog button[type=submit]');
        await admin.waitForSelector('table.data td strong:text-is("e2e-audio")', {state: 'detached'});
    });

    const mobileCtx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    const mobile = await mobileCtx.newPage();
    watch(mobile, 'mobile');
    current = mobile;
    await step('mobile layout: toolbar fits, band opens on tap, no horizontal overflow', async () => {
        await mobile.goto(BASE + '/big/');
        await mobile.waitForSelector('#items .item.file');
        const box = await mobile.locator('#account').boundingBox();
        assert.ok(box && box.x + box.width <= 390, 'account button visible');
        await row(mobile, 'big.bin').locator('a.main').tap();
        await mobile.waitForSelector('.band .download-btn');
        const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, 'overflow ' + overflow);
        await mobile.screenshot({path: `${SHOTS}/e2e-17-mobile-band.png`});
    });

    await browser.close();
    console.log(results.join('\n'));
    console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no console errors / dialogs');
    process.exit(results.some(r => r.startsWith('FAIL')) || problems.length ? 1 : 0);
})();

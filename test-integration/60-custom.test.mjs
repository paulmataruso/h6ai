// Custom header/footer lookup (S11).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api} from './lib.mjs';

const custom = async href => {
    const {res, json} = await api({action: 'get', custom: href});
    assert.ok(json, `custom ${href}: non-JSON (HTTP ${res.status}) ${res.text.slice(0, 200)}`);
    assert.ok(res.status < 500, `custom ${href}: ${res.status}`);
    return {res, json, text: res.text};
};

test('custom header (md) and footer (html) are found for /docs/', async () => {
    const {json} = await custom('/docs/');
    assert.equal(json.custom.header.type, 'md');
    assert.match(json.custom.header.content, /Header from/);
    assert.equal(json.custom.footer.type, 'html');
    assert.match(json.custom.footer.content, /Footer from/);
});

test('S11: custom files outside the web root are never read', async () => {
    for (const href of ['/../outside/', '/%2e%2e/outside/', '/docs/../../outside/', '/images/%2e%2e/%2e%2e/outside/', '/../', '/..']) {
        const {json, text} = await custom(href);
        assert.ok(!text.includes('OUTSIDE-SECRET'), `${href}: leaked outside header`);
        assert.ok(!text.includes('ABOVE-ROOT-SECRET'), `${href}: leaked above-root header`);
        if (!json.err) {
            assert.equal(json.custom.header.content, null, `${href}: header`);
            assert.equal(json.custom.footer.content, null, `${href}: footer`);
        }
    }
});

test('S11: inherited "headers" lookup stops at the web root', async () => {
    for (const href of ['/', '/images/', '/unicode/Ordner%20mit%20%C3%9Cmlaut/']) {
        const {text} = await custom(href);
        assert.ok(!text.includes('ABOVE-ROOT-SECRET'), `${href}: read _h6ai.headers.html above the root`);
    }
});

test('S11: hidden folders yield no customisations', async () => {
    const {json, text} = await custom('/.hidden/');
    assert.ok(json.err || (json.custom.header.content === null && json.custom.footer.content === null), text.slice(0, 200));
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {lib} = require('./setup');

const icons = lib('core/icons');

test('icons are inline svg using currentColor', () => {
    const svg = icons.icon('download');
    assert.match(svg, /^<svg class="ui-icon ui-icon-download"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /aria-hidden="true"/);
    assert.match(icons.icon('search', 'Search'), /role="img" aria-label="Search"/);
    assert.ok(icons.has('download'));
    assert.ok(icons.has('close'));
    assert.ok(!icons.has('nope'));
});

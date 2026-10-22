// Loads frontend modules in Node with a jsdom window and a minimal config, so pure modules
// (format, util, sanitize, ...) can be unit tested without a browser.
const {JSDOM} = require('jsdom');
const path = require('path');

if (!global.window) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://localhost/'});
    global.window = dom.window;
}

const LIB = path.join(__dirname, '..', 'src', '_h6ai', 'public', 'js', 'lib');

const config = require(path.join(LIB, 'config'));
Object.assign(config, {
    setup: {PUBLIC_HREF: '/_h6ai/public/', ROOT_HREF: '/'},
    options: {},
    types: {},
    theme: {}
});

module.exports = {
    lib: name => require(path.join(LIB, name))
};

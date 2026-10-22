const {test} = require('node:test');
const assert = require('node:assert/strict');
const {lib} = require('./setup');

const {sanitizeHtml, markdownToHtml} = lib('util/sanitize');

// Audit finding S5: markdown and custom HTML used to be injected unsanitized.
test('markdown is rendered without script vectors', () => {
    const html = markdownToHtml([
        '# Title',
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '[click](javascript:alert(1))',
        '<a href="https://example.com" target="_blank">ext</a>',
        '<iframe src="https://evil.example"></iframe>',
        '<svg><script>alert(1)</script></svg>'
    ].join('\n\n'));

    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /onerror/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /<iframe/i);
    assert.match(html, /rel="noopener noreferrer"/);
});

test('custom html keeps markup but drops handlers, forms and styles', () => {
    const html = sanitizeHtml('<p style="color:red" onclick="x()">hi <b>there</b></p><form action="/x"><input></form><style>*{}</style>');
    assert.equal(html, '<p>hi <b>there</b></p>');
});

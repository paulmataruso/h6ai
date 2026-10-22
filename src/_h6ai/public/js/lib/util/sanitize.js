const createDOMPurify = require('dompurify');
const {marked} = require('marked');

let purify = null;

const getPurify = () => {
    if (!purify) {
        purify = createDOMPurify(global.window);
        // links in rendered content must not get access to window.opener
        purify.addHook('afterSanitizeAttributes', node => {
            if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
                node.setAttribute('rel', 'noopener noreferrer');
            }
        });
    }
    return purify;
};

// Removes scripts, event handlers, javascript: URLs, forms etc. from untrusted HTML.
const sanitizeHtml = html => getPurify().sanitize(String(html), {
    USE_PROFILES: {html: true},
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style']
});

// Renders markdown (GitHub flavoured) to sanitized HTML. Raw HTML inside the markdown is kept
// but sanitized as well.
const markdownToHtml = md => sanitizeHtml(marked.parse(String(md), {gfm: true, breaks: false, async: false}));

module.exports = {
    sanitizeHtml,
    markdownToHtml
};

const {dom} = require('../util');
const base = require('./base');

// Small toast in the bottom corner. set(text) shows a persistent message (e.g. "loading"),
// set() hides it, error(text) shows an error that fades out on its own.
const init = () => {
    const $el = dom('<div id="notification" role="status" aria-live="polite"></div>').hide().appTo(base.$root);
    let timeoutId = null;

    const set = (content, kind = 'info') => {
        clearTimeout(timeoutId);
        if (content) {
            $el.text(content).rmCls('info', 'error').addCls(kind).show();
        } else {
            $el.hide();
        }
    };

    const error = content => {
        set(content, 'error');
        timeoutId = setTimeout(() => set(), 6000);
    };

    return {
        set,
        error
    };
};

module.exports = init();

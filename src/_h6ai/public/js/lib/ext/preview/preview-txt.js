const lolight = require('lolight');
const {keys, dom} = require('../../util');
const {markdownToHtml} = require('../../util/sanitize');
const format = require('../../core/format');
const allsettings = require('../../core/settings');
const preview = require('./preview');

const win = global.window;
const MAX_BYTES = 2 * 1024 * 1024; // larger files are truncated in the preview
const settings = Object.assign({
    enabled: false,
    styles: {}
}, allsettings['preview-txt']);
const preTpl = '<pre id="pv-content-txt"></pre>';
const divTpl = '<div id="pv-content-txt"></div>';

const updateGui = () => {
    const el = dom('#pv-content-txt')[0];
    if (!el) {
        return;
    }

    preview.setLabels([
        preview.item.label,
        format.formatSize(preview.item.size)
    ]);
};

const requestTextContent = href => {
    return win.fetch(href, {credentials: 'same-origin', headers: {Range: `bytes=0-${MAX_BYTES - 1}`}})
        .then(resp => {
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            // servers answer 206 even if the whole (small) file fits into the range
            const range = /\/(\d+)$/.exec(resp.headers.get('Content-Range') || '');
            const total = range ? Number(range[1]) : null;
            return resp.text().then(text => {
                const truncated = total !== null ? total > MAX_BYTES : text.length >= MAX_BYTES;
                return truncated ? text + '\n\n[… preview truncated, open the raw file to see everything]' : text;
            });
        });
};

const load = item => {
    return requestTextContent(item.absHref)
        .catch(err => '[request failed] ' + (err.message || err))
        .then(content => {
            const style = settings.styles[item.type];

            if (style === 1) {
                return dom(preTpl).text(content);
            } else if (style === 2) {
                return dom(divTpl).addCls('markdown').html(markdownToHtml(content));
            } else if (style === 3) {
                const $code = dom('<code></code>').text(content);
                win.setTimeout(() => {
                    lolight.el($code[0]);
                }, content.length < 20000 ? 0 : 500);
                return dom(preTpl).app($code);
            }

            return dom(divTpl).text(content);
        });
};

const init = () => {
    if (settings.enabled) {
        preview.register(keys(settings.styles), load, updateGui);
    }
};


init();

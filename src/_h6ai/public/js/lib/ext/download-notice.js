// Stamped download confirmation for downloads that start outside a band (download chip,
// single-click modes, archives, preview fallbacks): what started, how big, whether it resumes.
// A download started from a band is stamped inside the band instead (ext/expand.js).
const {dom} = require('../util');
const {copyText} = require('../util/clipboard');
const format = require('../core/format');
const resource = require('../core/resource');
const base = require('../view/base');

const win = global.window;
const tpl =
        `<div id="dl-notice" role="status" aria-live="polite" hidden>
            <span class="dl-notice-icon"></span>
            <div class="dl-notice-text">
                <strong class="dl-notice-title"></strong>
                <span class="dl-notice-meta"></span>
            </div>
            <button class="btn small dl-notice-copy" type="button">Copy link</button>
            <button class="bar-button dl-notice-close" type="button" aria-label="Dismiss">${resource.ui('close')}</button>
        </div>`;

let $el = null;
let hideId = null;
let link = '';

const hideLater = ms => {
    win.clearTimeout(hideId);
    hideId = win.setTimeout(() => {
        // keep it while the visitor interacts with it
        if ($el && !$el[0].matches(':hover, :focus-within')) {
            $el.attr('hidden', '');
        } else {
            hideLater(2000);
        }
    }, ms);
};

const ensure = () => {
    if ($el) {
        return $el;
    }
    $el = dom(tpl).appTo(base.$root);
    $el.find('.dl-notice-close').on('click', () => $el.attr('hidden', ''));
    $el.find('.dl-notice-copy').on('click', () => {
        copyText(link).then(ok => {
            $el.find('.dl-notice-copy').text(ok ? 'Copied' : 'Copy failed');
            win.setTimeout(() => $el.find('.dl-notice-copy').text('Copy link'), 1800);
        });
    });
    return $el;
};

// show({name, size, href, state: 'downloading'|'preparing'|'started', note})
const show = ({title, meta, href, busy = false, stay = false}) => {
    ensure();
    link = href ? new URL(href, win.location.href).href : '';
    $el.find('.dl-notice-title').text(title);
    $el.find('.dl-notice-meta').text(meta || '');
    $el.find('.dl-notice-copy').prop('hidden', !link);
    // preparing pulses the download glyph; started is stamped with a check
    $el.find('.dl-notice-icon').html(resource.ui(busy ? 'download' : 'check'));
    if (busy) {
        $el.addCls('busy');
    } else {
        $el.rmCls('busy');
    }
    // replay the stamp-in when a new download replaces the previous notice
    $el.rmCls('stamped');
    $el[0].getBoundingClientRect();
    $el.addCls('stamped');
    $el.rmAttr('hidden');
    win.clearTimeout(hideId);
    if (!stay) {
        hideLater(8000);
    }
};

const fileStarted = item => show({
    title: `Downloading ${item.label}`,
    meta: [format.formatSize(item.size), 'resumable'].filter(Boolean).join(' · '),
    href: item.absHref
});

module.exports = {
    show,
    fileStarted
};

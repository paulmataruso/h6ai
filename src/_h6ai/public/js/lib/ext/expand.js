// Inline row expansion: clicking a file the browser can't preview unfolds its row in place into
// a download band (explicit "Download 7.5 GB", resumable note, direct link, curl and wget lines,
// QR code). The admin's "click on a file name" setting can switch this to plain downloads.
const {each, dom} = require('../util');
const {copyText} = require('../util/clipboard');
const config = require('../config');
const event = require('../core/event');
const format = require('../core/format');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const preview = require('./preview/preview');
const notice = require('./download-notice');

const win = global.window;
const site = ((config.setup || {}).SITE || {});
const clickAction = ['expand', 'download-other', 'download'].includes(site.clickAction) ? site.clickAction : 'expand';
const qrSettings = Object.assign({qrFill: '#000000', qrBack: '#ffffff'}, allsettings.info);

const TYPE_LABELS = {
    ar: 'archive', aud: 'audio', bin: 'program', img: 'image', txt: 'text', vid: 'video', x: 'document', file: 'file'
};

const bandTpl =
        `<li class="band">
            <div class="band-inner" role="region">
                <div class="band-head">
                    <a class="btn download-btn" download>${resource.ui('download')}<span class="download-btn-label"></span></a>
                    <span class="band-note"></span>
                    <button class="bar-button band-close" type="button" aria-label="Close">${resource.ui('close')}</button>
                </div>
                <dl class="band-links"></dl>
                <div class="band-foot">
                    <button class="btn small band-qr-toggle" type="button" aria-expanded="false">Show QR code</button>
                    <div class="band-qr" hidden></div>
                </div>
            </div>
        </li>`;
// after the click the band keeps a stamped ticket: what started, when, how big, resumable
const stampTpl =
        `<div class="band-stamp" role="status">
            <span class="band-stamp-stub">${resource.ui('check')}</span>
            <span class="band-stamp-body">
                <strong class="band-stamp-title">Download started</strong>
                <span class="band-stamp-meta"></span>
            </span>
        </div>`;
const lineTpl =
        `<div class="band-line">
            <dt></dt>
            <dd><code></code><button class="btn small copy" type="button">Copy</button></dd>
        </div>`;

let open = null; // {item, $band}

const pad = n => String(n).padStart(2, '0');
const clock = () => {
    const now = new Date();
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
};

const stamp = ($band, $dl, item) => {
    const meta = [clock(), format.formatSize(item.size), 'resumable'].filter(Boolean).join(' · ');
    let $stamp = $band.find('.band-stamp');
    if (!$stamp.length) {
        $stamp = dom(stampTpl);
        const head = $band.find('.band-head')[0];
        head.insertBefore($stamp[0], head.firstChild);
        // the primary action is done: the same link stays as a quiet "Download again"
        $dl.rmCls('download-btn');
        $band.find('.download-btn-label').text('Download again');
        $band.addCls('started');
    } else {
        // a second click restamps: replay the stamp so it reads as a new event
        $stamp.rmCls('restamp');
        $stamp[0].getBoundingClientRect();
        $stamp.addCls('restamp');
    }
    $stamp.find('.band-stamp-meta').text(meta);
};

const typeLabel = item => TYPE_LABELS[(item.type || 'file').split('-')[0]] || 'file';
// the public address from the admin's reverse proxy settings, else this page's own
const absoluteUrl = item => new URL(item.absHref, site.publicUrl || win.location.href).href;

const close = (restoreFocus = true) => {
    if (!open) {
        return;
    }
    const {item, $band} = open;
    open = null;
    $band.rm();
    if (item.$view) {
        item.$view.rmCls('expanded');
        const $a = item.$view.find('a.main').attr('aria-expanded', 'false');
        if (restoreFocus) {
            $a[0].focus();
        }
    }
};

// in grid/icons views the band goes after the last tile of the clicked tile's visual row
const insertionPoint = li => {
    let last = li;
    let next = li.nextElementSibling;
    while (next && next.classList.contains('item') && Math.abs(next.offsetTop - li.offsetTop) < 2) {
        last = next;
        next = next.nextElementSibling;
    }
    return last;
};

const addLine = ($list, label, text) => {
    const $line = dom(lineTpl);
    $line.find('dt').text(label);
    $line.find('code').text(text);
    const $copy = $line.find('.copy').attr('aria-label', `Copy ${label}`);
    $copy.on('click', () => {
        copyText(text).then(ok => {
            $copy.text(ok ? 'Copied' : 'Copy failed');
            win.setTimeout(() => $copy.text('Copy'), 1600);
        });
    });
    $line.appTo($list);
};

const expand = item => {
    const same = open && open.item === item;
    close(false);
    if (same) {
        item.$view.find('a.main')[0].focus();
        return;
    }

    const url = absoluteUrl(item);
    const size = format.formatSize(item.size);
    const id = 'band-' + Math.random().toString(36).slice(2, 9);
    const $band = dom(bandTpl);
    $band.find('.band-inner').attr('id', id).attr('aria-label', `Download ${item.label}`);

    const $dl = $band.find('.download-btn').attr('href', item.absHref);
    $band.find('.download-btn-label').text(size ? `Download ${size}` : 'Download');
    // stamp after the click has run its course, so the browser's download is never disturbed
    $dl.on('click', () => win.setTimeout(() => stamp($band, $dl, item), 0));

    const date = format.formatDate(item.time);
    const kind = typeLabel(item);
    $band.find('.band-note').text(['Resumable', kind !== 'file' ? kind : '', date ? 'modified ' + date : ''].filter(Boolean).join(' · '));

    const quoted = `'${url}'`;
    const $links = $band.find('.band-links');
    addLine($links, 'Direct link', url);
    addLine($links, 'curl', `curl -L -C - -O ${quoted}`);
    addLine($links, 'wget', `wget -c ${quoted}`);

    const $qrToggle = $band.find('.band-qr-toggle');
    const $qr = $band.find('.band-qr');
    $qrToggle.on('click', () => {
        const show = $qr[0].hidden;
        if (show && !$qr[0].firstChild) {
            const kjua = require('kjua');
            $qr.app(kjua({render: 'image', size: 176, fill: qrSettings.qrFill, back: qrSettings.qrBack, text: url, crisp: true, quiet: 1}));
            $qr.find('img').attr('alt', `QR code for ${item.label}`);
        }
        $qr[0].hidden = !show;
        $qrToggle.attr('aria-expanded', show ? 'true' : 'false').text(show ? 'Hide QR code' : 'Show QR code');
    });

    $band.find('.band-close').on('click', () => close());
    $band.on('keydown', ev => {
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            ev.preventDefault();
            close();
        }
    });

    const li = item.$view[0];
    const after = insertionPoint(li);
    after.parentNode.insertBefore($band[0], after.nextSibling);
    item.$view.addCls('expanded');
    item.$view.find('a.main').attr('aria-expanded', 'true').attr('aria-controls', id);
    open = {item, $band};

    // show as much of the band as fits, but never scroll its row out of sight
    $band[0].scrollIntoView({block: 'nearest'});
    li.scrollIntoView({block: 'nearest'});
    $dl[0].focus({preventScroll: true});
};

const initItem = item => {
    if (!item.$view || item.isFolder() || preview.handles(item)) {
        return;
    }
    const $a = item.$view.find('a.main');
    if (clickAction === 'expand') {
        $a.attr('aria-expanded', 'false').on('click', ev => {
            if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1) {
                return; // modified clicks keep their native meaning
            }
            ev.preventDefault();
            expand(item);
        });
    } else {
        $a.attr('download', '').on('click', () => notice.fileStarted(item));
    }
};

const init = () => {
    event.sub('view.changed', (added, removed) => {
        // keep an open band across auto-refreshes, unless its row went away
        if (open && (!open.item.$view || !open.item.$view[0].isConnected || (removed || []).includes(open.item))) {
            close(false);
        }
        each(added, initItem);
    });
    event.sub('view.sorted', () => close(false));
    event.sub('location.beforeChange', () => close(false));
};


init();

module.exports = {
    expand,
    close
};

// Packaged (tar/zip) download of the selection, or of the whole folder with alwaysVisible.
// The button says what it will produce ("Download 3 items · 1.2 MB · .tar") and the notice
// tracks the stream: "Preparing…" until the server's start cookie arrives.
const {each, dom} = require('../util');
const server = require('../server');
const event = require('../core/event');
const format = require('../core/format');
const location = require('../core/location');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const notice = require('./download-notice');

const win = global.window;
const settings = Object.assign({
    enabled: false,
    type: 'php-tar',
    packageName: 'package',
    alwaysVisible: false
}, allsettings.download);
const extension = settings.type === 'shell-zip' ? 'zip' : 'tar';
const tpl =
        `<button id="download" class="tool download-action" type="button">
            ${resource.ui('download')}<span class="download-label"></span>
        </button>`;

const clearTpl =
        `<button id="clear-selection" class="tool" type="button" title="Clear selection (Esc)" aria-label="Clear selection">
            ${resource.ui('close')}
        </button>`;

let selectedItems = [];
let $download;
let $clear;

const totalSize = items => {
    let total = 0;
    let known = true;
    each(items, item => {
        if (typeof item.size === 'number') {
            total += item.size;
        } else {
            known = false;
        }
    });
    return known ? total : null;
};

const label = () => {
    const count = selectedItems.length;
    if (!count) {
        return {text: `Download folder · .${extension}`, title: `Download this folder as .${extension}`};
    }
    const size = totalSize(selectedItems);
    const what = count === 1 ? '1 item' : `${count} items`;
    return {
        text: `Download ${what}${size !== null ? ' · ' + format.formatSize(size) : ''} · .${extension}`,
        title: `Download the selected ${what} as one .${extension} archive`
    };
};

const update = () => {
    const {text, title} = label();
    $download.find('.download-label').text(text);
    $download.attr('title', title).attr('aria-label', title);
    if (selectedItems.length || settings.alwaysVisible) {
        $download.show();
    } else {
        $download.hide();
    }
    if (selectedItems.length) {
        $clear.show();
    } else {
        $clear.hide();
    }
};

const onSelection = items => {
    selectedItems = items.slice(0);
    update();
};

// the server sets "h6ai_dl_<token>" once the archive starts streaming
const watchStart = (token, name, what) => {
    const started = Date.now();
    const cookie = `h6ai_dl_${token}=`;
    const poll = () => {
        if (win.document.cookie.includes(cookie)) {
            win.document.cookie = `h6ai_dl_${token}=; Max-Age=0; path=/; SameSite=Strict`;
            notice.show({title: `Downloading ${name}`, meta: `${what} · streaming, not resumable`});
            return;
        }
        if (Date.now() - started > 120000) {
            notice.show({title: `Still preparing ${name}`, meta: 'large folders can take a while to start'});
            return;
        }
        win.setTimeout(poll, 400);
    };
    poll();
};

const onClick = () => {
    const type = settings.type;
    let name = settings.packageName;

    if (!name) {
        if (selectedItems.length === 1) {
            name = selectedItems[0].label;
        } else {
            name = location.getItem().label;
        }
    }

    const file = name + '.' + extension;
    const token = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    const query = {
        action: 'download',
        as: file,
        type,
        baseHref: location.getAbsHref(),
        hrefs: '',
        token
    };

    each(selectedItems, (item, idx) => {
        query[`hrefs[${idx}]`] = item.absHref;
    });

    const what = label().text.replace(/^Download /, '');
    notice.show({title: `Preparing ${file}`, meta: what, busy: true, stay: true});
    watchStart(token, file, what);
    event.pub('download.archive', location.getAbsHref());
    server.formRequest(query);
};

const init = () => {
    if (!settings.enabled) {
        return;
    }

    $download = dom(tpl)
        .hide()
        .appTo('#tools-output')
        .on('click', onClick);
    $clear = dom(clearTpl)
        .hide()
        .appTo('#tools-output')
        .on('click', () => require('./select').clearSelection());

    update();
    event.sub('selection', onSelection);
};


init();

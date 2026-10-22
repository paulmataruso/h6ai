const {each, map, includes, intersection, dom} = require('../util');
const event = require('../core/event');
const format = require('../core/format');
const location = require('../core/location');
const resource = require('../core/resource');
const store = require('../core/store');
const allsettings = require('../core/settings');
const config = require('../config');
const base = require('./base');

const modes = ['details', 'grid', 'icons'];
const sizes = [20, 40, 60, 80, 100, 150, 200, 250, 300, 350, 400];
const settings = Object.assign({
    binaryPrefix: false,
    hideFolders: false,
    hideParentFolder: false,
    maxIconSize: 40,
    modes,
    setParentFolderLabels: false,
    sizes
}, allsettings.view);
const siteName = ((config.setup || {}).SITE || {}).name || 'h6ai';
const sortedSizes = settings.sizes.slice().sort((a, b) => a - b);
const checkedModes = intersection(settings.modes, modes);
const storekey = 'view';
const viewTpl =
        `<div id="view">
            <p id="view-status" role="status" aria-live="polite" hidden></p>
            <ul id="items" role="list">
                <li class="header">
                    <span class="icon"></span>
                    <button class="label" type="button"><span class="l10n-name">Name</span><span class="sort-state visually-hidden"></span></button>
                    <button class="date" type="button"><span class="l10n-lastModified">Last modified</span><span class="sort-state visually-hidden"></span></button>
                    <button class="size" type="button"><span class="l10n-size">Size</span><span class="sort-state visually-hidden"></span></button>
                </li>
            </ul>
            <div id="view-hint" role="status" aria-live="polite"></div>
        </div>`;
// a.main opens/previews/expands, a.dl (files only) always downloads; links can't nest, so
// the download chip is a sibling laid over the size column
const itemTpl =
        `<li class="item">
            <a class="main">
                <span class="icon square"><img alt="" loading="lazy" decoding="async"></span>
                <span class="icon landscape"><img alt="" loading="lazy" decoding="async"></span>
                <span class="name"><span class="label"></span><span class="path"></span><span class="meta"></span></span>
                <span class="date"></span>
                <span class="size"></span>
            </a>
        </li>`;
const dlTpl =
        `<a class="dl" download>${resource.ui('download')}<span class="dl-size"></span></a>`;
const $view = dom(viewTpl);
const $items = $view.find('#items');
const $hint = $view.find('#view-hint');
const $status = $view.find('#view-status');


// Item sizes are driven by CSS custom properties (see view.css), no runtime <style> elements,
// which keeps the page compatible with a strict Content-Security-Policy.
const applySize = size => {
    $view[0].style.setProperty('--size', String(size));
    $view[0].style.setProperty('--max-icon', settings.maxIconSize + 'px');
};

const set = (mode, size) => {
    const stored = store.get(storekey);

    mode = mode || stored && stored.mode;
    size = size || stored && stored.size;
    mode = includes(settings.modes, mode) ? mode : settings.modes[0];
    size = includes(settings.sizes, size) ? size : settings.sizes[0];
    store.put(storekey, {mode, size});

    each(checkedModes, m => {
        if (m === mode) {
            $view.addCls('view-' + m);
        } else {
            $view.rmCls('view-' + m);
        }
    });

    applySize(size);
    event.pub('view.mode.changed', mode, size);
};

const getModes = () => checkedModes;
const getMode = () => store.get(storekey).mode;
const setMode = mode => set(mode, null);

const getSizes = () => sortedSizes;
const getSize = () => store.get(storekey).size;
const setSize = size => set(null, size);

const closestItem = el => {
    while (el && !el._item && el.parentNode) {
        el = el.parentNode;
    }
    return el && el._item;
};

const onMouseenter = ev => {
    event.pub('item.mouseenter', closestItem(ev.target));
};

const onMouseleave = ev => {
    event.pub('item.mouseleave', closestItem(ev.target));
};

// "/a/b/" relative to the root, for search results outside the current folder
const folderPath = item => {
    const crumb = item.parent ? item.parent.getCrumb().slice(1).map(i => i.label) : [];
    return '/' + crumb.map(l => l + '/').join('');
};

const createHtml = item => {
    const $html = dom(itemTpl);
    const $a = $html.find('a.main');
    const $iconImg = $html.find('.icon img');
    const $label = $html.find('.label');
    const $path = $html.find('.path');
    const $meta = $html.find('.meta');
    const $date = $html.find('.date');
    const $size = $html.find('.size');
    const isFolder = item.isFolder();
    const isParent = item.isCurrentParentFolder();

    $html
        .addCls(isFolder ? 'folder' : 'file')
        .on('mouseenter', onMouseenter)
        .on('mouseleave', onMouseleave);
    $a.on('focus', onMouseenter).on('blur', onMouseleave);

    location.setLink($a, item);

    $label.text(item.label).attr('title', item.label);
    const date = format.formatDate(item.time);
    const size = format.formatSize(item.size);
    $date.attr('data-time', item.time).text(date);
    $size.attr('data-bytes', item.size).text(size);
    $meta.text([size, date].filter(Boolean).join(' · '));

    // search results come from other folders: say where
    if (!isParent && item.parent && !item.isInCurrentFolder()) {
        $path.text(folderPath(item));
        $html.addCls('elsewhere');
    } else {
        $path.rm();
    }

    item.icon = resource.icon(item.type);

    if (isFolder && !item.isManaged) {
        $html.addCls('page');
        item.icon = resource.icon('folder-page');
    }

    if (isParent) {
        item.icon = resource.icon('folder-parent');
        if (!settings.setParentFolderLabels) {
            $label.addCls('l10n-parentDirectory').text('Parent folder');
        }
        $html.addCls('folder-parent');
        $meta.text('');
    }
    $iconImg.attr('src', item.icon);

    if (!isFolder) {
        const $dl = dom(dlTpl)
            .attr('href', item.absHref)
            .attr('aria-label', `Download ${item.label}${size ? ', ' + size : ''}`)
            .attr('title', 'Download' + (size ? ' · ' + size : ''));
        $dl.find('.dl-size').text(size);
        $dl.on('click', () => require('../ext/download-notice').fileStarted(item));
        $html.app($dl);
    }

    item.$view = $html;
    $html[0]._item = item;

    return $html;
};

const checkHint = () => {
    const hasNoItems = $items.find('.item').length === $items.find('.folder-parent').length;

    if (hasNoItems) {
        $hint.show();
    } else {
        $hint.hide();
    }
};

const setItems = items => {
    const removed = map($items.find('.item'), el => el._item);

    $items.find('.item, .band').rm();

    const fragment = global.window.document.createDocumentFragment();
    each(items, item => fragment.appendChild(createHtml(item)[0]));
    $items[0].appendChild(fragment);

    base.$content[0].scrollLeft = 0;
    base.$content[0].scrollTop = 0;

    checkHint();
    event.pub('view.changed', items, removed);
};

const changeItems = (add, remove) => {
    each(add, item => {
        createHtml(item).appTo($items);
    });

    each(remove, item => {
        if (item.$view) {
            item.$view.rm();
        }
    });

    checkHint();
    event.pub('view.changed', add, remove);
};

// hint: l10n key for empty states, optional text + action button set by callers
const setHint = (l10nKey, text) => {
    $hint.clr().rmCls().addCls('l10n-' + l10nKey);
    if (text) {
        dom('<p></p>').text(text).appTo($hint);
    }
    event.pub('view.hint', l10nKey, $hint);
    checkHint();
};

// one line above the list: result counts for filter and search
const setStatus = text => {
    if (text) {
        $status.text(text).rmAttr('hidden');
    } else {
        $status.text('').attr('hidden', '');
    }
};

const onLocationChanged = item => {
    if (!item) {
        item = location.getItem();
    }

    const items = [];

    if (item.parent && !settings.hideParentFolder) {
        items.push(item.parent);
    }

    each(item.content, child => {
        if (!(child.isFolder() && settings.hideFolders)) {
            items.push(child);
        }
    });

    base.$title.text(item.parent ? item.label : siteName);
    setStatus();
    setHint(item.denied ? 'denied' : 'empty', item.denied ? null : 'This folder is empty.');
    setItems(items);
};

const onLocationRefreshed = (item, added, removed) => {
    const add = [];

    each(added, child => {
        if (!(child.isFolder() && settings.hideFolders)) {
            add.push(child);
        }
    });

    setHint(item.denied ? 'denied' : 'empty', item.denied ? null : 'This folder is empty.');
    changeItems(add, removed);
};

const onResize = () => {
    const width = $view[0].offsetWidth;

    $view.rmCls('width-0').rmCls('width-1');
    if (width < 560) {
        $view.addCls('width-0');
    } else if (width < 720) {
        $view.addCls('width-1');
    }
};

const init = () => {
    set();
    $view.appTo(base.$content);
    $hint.hide();

    format.setDefaultMetric(settings.binaryPrefix);

    event.sub('location.changed', onLocationChanged);
    event.sub('location.refreshed', onLocationRefreshed);
    event.sub('resize', onResize);

    if (global.window.ResizeObserver) {
        new global.window.ResizeObserver(onResize).observe($view[0]);
    }
    onResize();
};


init();

module.exports = {
    $el: $view,
    setItems,
    changeItems,
    setLocation: onLocationChanged,
    setHint,
    setStatus,
    getModes,
    getMode,
    setMode,
    getSizes,
    getSize,
    setSize
};

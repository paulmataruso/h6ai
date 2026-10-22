const {dom} = require('../util');
const location = require('../core/location');

const win = global.window;
const doc = win.document;

// Keyboard navigation for the listing:
//   arrows / j k    move focus between items (grid aware)
//   Enter           open (native link behaviour)
//   Backspace, Alt+↑  parent folder
//   Space           toggle selection of the focused item
//   Escape          clear selection
//   /               filter (or search)

const isTyping = el => el && (/^(INPUT|TEXTAREA|SELECT)$/).test(el.tagName) || el && el.isContentEditable;

const links = () => dom('#items .item:not(.hidden) > a.main').map(el => el);

const columns = list => {
    if (list.length < 2) {
        return 1;
    }
    const top = list[0].getBoundingClientRect().top;
    let count = 0;
    while (count < list.length && Math.abs(list[count].getBoundingClientRect().top - top) < 2) {
        count += 1;
    }
    return Math.max(1, count);
};

const move = delta => {
    const list = links();
    if (!list.length) {
        return;
    }
    const idx = list.indexOf(doc.activeElement);
    let next;
    if (!isFinite(delta)) {
        next = delta > 0 ? list.length - 1 : 0;
    } else if (idx < 0) {
        next = delta > 0 ? 0 : list.length - 1;
    } else {
        next = Math.min(list.length - 1, Math.max(0, idx + delta));
    }
    list[next].focus();
    list[next].scrollIntoView({block: 'nearest'});
};

const goUp = () => {
    const item = location.getItem();
    if (item && item.parent) {
        location.setLocation(item.parent.absHref);
    }
};

const onKeydown = ev => {
    if (ev.defaultPrevented || isTyping(ev.target) || dom('html').hasCls('pv-open') || doc.querySelector('dialog[open]')) {
        return;
    }
    const key = ev.key;
    const grid = !dom('#view').hasCls('view-details');
    const cols = grid ? columns(links()) : 1;

    if ((key === 's' || key === 'S') && !ev.ctrlKey && !ev.metaKey && !ev.altKey && dom('#search').length) {
        require('./search').open(); // recursive search, also when the filter owns "/"
    } else if (key === '/' && !ev.ctrlKey && !ev.metaKey) {
        const filter = require('./filter');
        const search = require('./search');
        if (dom('#filter').length) {
            filter.open();
        } else if (dom('#search').length) {
            search.open();
        } else {
            return;
        }
    } else if (key === 'ArrowDown' || key === 'j') {
        move(cols);
    } else if (key === 'ArrowUp' && ev.altKey || key === 'Backspace') {
        goUp();
    } else if (key === 'ArrowUp' || key === 'k') {
        move(-cols);
    } else if (key === 'ArrowRight' && grid) {
        move(1);
    } else if (key === 'ArrowLeft' && grid) {
        move(-1);
    } else if (key === 'ArrowRight' || key === 'ArrowLeft') {
        // details view: unfold / fold the focused file's download band
        const li = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest('#items .item.file');
        if (!li) {
            return;
        }
        const expand = require('./expand');
        if (key === 'ArrowRight' && !li.classList.contains('expanded') && !require('./preview/preview').handles(li._item)) {
            expand.expand(li._item);
        } else if (key === 'ArrowLeft' && li.classList.contains('expanded')) {
            expand.close();
        } else {
            return;
        }
    } else if (key === 'Home') {
        move(-Infinity);
    } else if (key === 'End') {
        move(Infinity);
    } else if (key === ' ' && doc.activeElement && doc.activeElement.closest && doc.activeElement.closest('#items .item')) {
        // rows only: Space on the sort buttons in the header row keeps its native click
        require('./select').toggleItem(doc.activeElement.closest('#items .item')._item);
    } else if (key === 'Escape') {
        require('./select').clearSelection();
    } else {
        return;
    }
    ev.preventDefault();
};

dom(win).on('keydown', onKeydown);

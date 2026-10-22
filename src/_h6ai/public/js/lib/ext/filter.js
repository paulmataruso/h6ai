const {filter, debounce, parsePattern, dom} = require('../util');
const event = require('../core/event');
const location = require('../core/location');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const view = require('../view/view');


const settings = Object.assign({
    enabled: false,
    advanced: false,
    debounceTime: 100,
    ignorecase: true
}, allsettings.filter);
const tpl =
        `<div id="filter" class="tool tool-input">
            <button class="tool-button" type="button" title="Filter (/)" aria-label="Filter">${resource.ui('filter')}</button>
            <input class="l10n_ph-filter" type="search" value="" placeholder="filter" aria-label="Filter" autocomplete="off" spellcheck="false">
        </div>`;
let inputIsVisible = false;
let prevPattern = '';
let $filter;
let $input;


const filterItems = (pattern = '') => {
    if (pattern === prevPattern) {
        return;
    }
    prevPattern = pattern;

    if (!pattern) {
        view.setLocation();
        return;
    }

    if (dom('#search').hasCls('active')) {
        require('./search').close(); // one query at a time
    }
    $filter.addCls('pending');

    let re;
    try {
        re = new RegExp(pattern, settings.ignorecase ? 'i' : '');
    } catch (err) {
        $filter.rmCls('pending').addCls('invalid');
        return;
    }
    $filter.rmCls('invalid');
    const items = filter(location.getItem().content, item => re.test(item.label));

    $filter.rmCls('pending');
    const typed = $input.val().trim();
    view.setHint('noMatch', `Nothing in this folder matches "${typed}".`);
    if (!items.length && dom('#search').length) {
        dom('<button class="btn" type="button">Search all folders</button>')
            .on('click', () => require('./search').open(typed))
            .appTo('#view-hint');
    }
    view.setItems(items);
    view.setStatus(`${items.length} ${items.length === 1 ? 'match' : 'matches'} for "${typed}" in this folder`);
};

const update = () => {
    if (!inputIsVisible) {
        $input[0].setAttribute('tabindex', '-1');
    } else {
        $input[0].removeAttribute('tabindex');
    }
    if (inputIsVisible) {
        $filter.addCls('active');
        $input[0].focus();
        filterItems(parsePattern($input.val(), settings.advanced));
    } else {
        filterItems();
        $filter.rmCls('active');
    }
};

const open = text => {
    if (typeof text === 'string') {
        $input.val(text);
    }
    if (!inputIsVisible) {
        toggle(); // eslint-disable-line no-use-before-define
    } else {
        $input[0].focus();
        update(); // eslint-disable-line no-use-before-define
    }
};

const toggle = () => {
    inputIsVisible = !inputIsVisible;
    update();
};

const reset = () => {
    inputIsVisible = false;
    $input.val('');
    update();
};

const init = () => {
    if (!settings.enabled) {
        return;
    }

    $filter = dom(tpl).appTo('#tools-find');
    $input = $filter.find('input').attr('tabindex', '-1');

    $filter.find('button').on('click', toggle);
    $input
        .on('input', debounce(update, settings.debounceTime))
        .on('keydown', ev => {
            if (ev.key === 'Escape') {
                ev.stopPropagation();
                reset();
            }
        });
    event.sub('location.changed', reset);
};


init();

module.exports = {
    open: text => $filter && open(text),
    close: () => $filter && inputIsVisible && reset()
};

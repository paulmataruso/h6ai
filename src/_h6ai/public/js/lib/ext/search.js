const {map, debounce, parsePattern, dom} = require('../util');
const server = require('../server');
const event = require('../core/event');
const location = require('../core/location');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const Item = require('../model/item');
const view = require('../view/view');


const settings = Object.assign({
    enabled: false,
    advanced: false,
    debounceTime: 300,
    ignorecase: true
}, allsettings.search);
const tpl =
        `<div id="search" class="tool tool-input">
            <button class="tool-button" type="button" title="Search (/)" aria-label="Search">${resource.ui('search')}</button>
            <input class="l10n_ph-search" type="search" value="" placeholder="search" aria-label="Search" autocomplete="off" spellcheck="false">
        </div>`;
let inputIsVisible = false;
let prevPattern = '';
let $search;
let $input;


const search = (pattern = '') => {
    if (pattern === prevPattern) {
        return;
    }
    prevPattern = pattern;

    if (!pattern) {
        view.setLocation();
        return;
    }

    $search.addCls('pending');

    server.request({
        action: 'get',
        search: {
            href: location.getAbsHref(),
            pattern,
            ignorecase: settings.ignorecase
        }
    }).then(response => {
        $search.rmCls('pending');
        if (pattern !== prevPattern) {
            return; // a newer search is in flight
        }
        const typed = $input.val().trim();
        const results = response.search || [];
        const where = location.getItem().isRoot() ? 'all folders' : `${location.getItem().label} and its subfolders`;
        view.setHint('noMatch', `Nothing in ${where} matches "${typed}".`);
        view.setItems(map(results, item => Item.get(item)));
        view.setStatus(`${results.length} ${results.length === 1 ? 'result' : 'results'} for "${typed}" in ${where}`);
    });
};

const update = () => {
    if (!inputIsVisible) {
        $input[0].setAttribute('tabindex', '-1');
    } else {
        $input[0].removeAttribute('tabindex');
    }
    if (inputIsVisible) {
        $search.addCls('active');
        $input[0].focus();
        search(parsePattern($input.val(), settings.advanced));
    } else {
        search();
        $search.rmCls('active');
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

    $search = dom(tpl).appTo('#tools-find');
    $input = $search.find('input').attr('tabindex', '-1');

    $search.find('button').on('click', toggle);
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
    open: text => $search && open(text),
    close: () => $search && inputIsVisible && reset()
};

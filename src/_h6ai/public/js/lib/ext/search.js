const {map, dom} = require('../util');
const server = require('../server');
const event = require('../core/event');
const location = require('../core/location');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const Item = require('../model/item');
const view = require('../view/view');

// Search over every folder below the current one (docs/SEARCH.md). The text goes to the
// server as typed; the server parses it (words, "phrases", -exclusions, *wildcards, re:).
//
// Gentle on the server: requests start after a typing pause, at most one is in flight per
// tab (a newer query waits for it, or cancels it after a second), recent answers are kept
// for a minute, and a busy or rate limited server is retried with growing pauses.
const settings = Object.assign({
    enabled: false,
    debounceTime: 250,
    ignorecase: true
}, allsettings.search);
const tpl =
        `<div id="search" class="tool tool-input">
            <button class="tool-button" type="button" title="Search (/)" aria-label="Search">${resource.ui('search')}</button>
            <input class="l10n_ph-search" type="search" value="" placeholder="search" aria-label="Search" autocomplete="off" spellcheck="false">
        </div>`;
const CACHE_SIZE = 20;
const CACHE_MS = 60000;
const PATIENCE_MS = 1000;
const RETRIES = 4;

let inputIsVisible = false;
let $search;
let $input;
let shown = '';          // key of the query whose results are on screen
let wanted = null;       // the latest query: {key, href, q}
let inflight = null;     // {key, controller, started}
let retryTimer = null;
let typingTimer = null;
const cache = new Map(); // key -> {at, items, info}

const keyOf = (href, q) => `${href}\n${settings.ignorecase ? 'i' : ''}\n${q}`;

const where = () => location.getItem().isRoot() ? 'all folders' : `${location.getItem().label} and its subfolders`;

const showStatus = (text, invalid = false) => {
    if (invalid) {
        $search.addCls('invalid');
    } else {
        $search.rmCls('invalid');
    }
    view.setStatus(text);
};

const describe = (count, typed, info) => {
    const quoted = `"${typed}"`;
    if (!count) {
        return info.truncated ? `Nothing found for ${quoted} in ${where()} so far (the search stopped early). Try more specific words.` : '';
    }
    const results = `${count} ${count === 1 ? 'result' : 'results'}`;
    if (info.more) {
        return `The best ${results} for ${quoted} in ${where()}. Add words to narrow it down.`;
    }
    if (info.truncated) {
        return `${results} for ${quoted} in ${where()}. The search stopped early, more specific words find the rest.`;
    }
    return `${results} for ${quoted} in ${where()}`;
};

const render = (key, typed, entry) => {
    shown = key;
    const items = map(entry.items, item => Item.get(item));
    view.setHint('noMatch', `Nothing in ${where()} matches "${typed}".`);
    view.setItems(items, {ranked: true});
    showStatus(describe(items.length, typed, entry.info));
    if (entry.info.ms !== undefined && $search) {
        // admins: what it cost
        $search.attr('title', `${entry.info.ms} ms, ${entry.info.indexed ? 'index' : 'folder walk' + (entry.info.reason ? ': ' + entry.info.reason : '')}${entry.info.stale ? ', index being rebuilt' : ''}`);
    }
};

const remember = (key, entry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_SIZE) {
        cache.delete(cache.keys().next().value);
    }
};

const cached = key => {
    const entry = cache.get(key);
    if (!entry || Date.now() - entry.at > CACHE_MS) {
        cache.delete(key);
        return null;
    }
    remember(key, entry);
    return entry;
};

const stopRetry = () => {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
        $search.rmCls('pending');
    }
};

const isWanted = key => wanted !== null && wanted.key === key;

// runs the latest query, unless one is still in flight (then it follows when that one is done)
const pump = (attempt = 0) => {
    if (inflight || wanted === null || wanted.key === shown) {
        return;
    }
    const {key, href, q} = wanted;
    const controller = global.window.AbortController ? new global.window.AbortController() : null;
    inflight = {key, controller, started: Date.now()};
    $search.addCls('pending');

    server.request({
        action: 'get',
        search: {href, q, ignorecase: settings.ignorecase}
    }, {quiet: true, signal: controller ? controller.signal : undefined}).then(response => {
        inflight = null;
        $search.rmCls('pending');
        const err = response && response.err;

        if (!err) {
            const entry = {at: Date.now(), items: response.search || [], info: response.searchInfo || {}};
            remember(key, entry);
            if (isWanted(key) && inputIsVisible) {
                render(key, q, entry);
            }
        } else if (isWanted(key) && inputIsVisible && err !== 'ERR_ABORTED') {
            if ((err === 'ERR_BUSY' || err === 'ERR_RATE_LIMITED') && attempt < RETRIES) {
                // the server sheds load: try again later, longer each time, a bit at random
                const pause = (err === 'ERR_BUSY' ? 500 : 3000) * Math.pow(2, attempt) * (0.75 + Math.random() / 2);
                showStatus(err === 'ERR_BUSY' ? 'Search is busy, trying again…' : 'Too many searches, waiting a moment…');
                stopRetry();
                $search.addCls('pending');
                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    $search.rmCls('pending');
                    pump(attempt + 1);
                }, pause);
                return;
            }
            shown = '';
            showStatus(err === 'ERR_ILLEGAL_PARAM' ? response.msg : `Search failed: ${response.msg || err}`, err === 'ERR_ILLEGAL_PARAM');
        }
        pump();
    });

    // a newer query doesn't wait more than a second for an old one
    setTimeout(() => {
        if (inflight && inflight.key === key && !isWanted(key) && inflight.controller) {
            inflight.controller.abort();
        }
    }, PATIENCE_MS);
};

const search = (text = '') => {
    const typed = text.trim();
    stopRetry();
    if (!typed) {
        wanted = null;
        shown = '';
        $search.rmCls('invalid').rmCls('pending');
        if (inflight && inflight.controller) {
            inflight.controller.abort();
        }
        view.setLocation();
        return;
    }
    const href = location.getAbsHref();
    const key = keyOf(href, typed);
    if (isWanted(key) && (key === shown || inflight || retryTimer)) {
        return;
    }
    wanted = {key, href, q: typed};
    if (dom('#filter').hasCls('active')) {
        require('./filter').close(); // one query at a time
    }
    const entry = cached(key);
    if (entry) {
        render(key, typed, entry);
        return;
    }
    if (inflight && Date.now() - inflight.started > PATIENCE_MS && inflight.controller) {
        inflight.controller.abort();
    }
    pump();
};

const update = () => {
    clearTimeout(typingTimer);
    if (!inputIsVisible) {
        $input[0].setAttribute('tabindex', '-1');
    } else {
        $input[0].removeAttribute('tabindex');
    }
    if (inputIsVisible) {
        $search.addCls('active');
        $input[0].focus();
        search($input.val());
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
        update();
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
        .on('input', () => {
            clearTimeout(typingTimer);
            typingTimer = setTimeout(update, Math.max(0, Number(settings.debounceTime) || 0));
        })
        .on('keydown', ev => {
            if (ev.key === 'Escape') {
                ev.stopPropagation();
                reset();
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                update(); // no need to wait for the typing pause
            }
        });
    event.sub('location.changed', () => {
        if (inputIsVisible) {
            reset();
        }
    });
};


init();

module.exports = {
    open: text => $search && open(text),
    close: () => $search && inputIsVisible && reset()
};

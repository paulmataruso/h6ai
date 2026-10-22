const {each, isFn, dom, includes, compact} = require('../../util');
const event = require('../../core/event');
const resource = require('../../core/resource');
const allsettings = require('../../core/settings');
const store = require('../../core/store');

const win = global.window;
const settings = Object.assign({
    enabled: true
}, allsettings.preview);
const overlayTpl =
        `<div id="pv-overlay" role="dialog" aria-modal="true" aria-label="preview" tabindex="-1">
            <div id="pv-container"></div>
            <div id="pv-spinner"><img class="back" alt=""><span class="spinner">${resource.ui('spinner')}</span></div>
            <button id="pv-prev-area" class="hof" type="button" aria-label="previous">${resource.ui('chevron-left')}</button>
            <button id="pv-next-area" class="hof" type="button" aria-label="next">${resource.ui('chevron-right')}</button>
            <div id="pv-bottombar" class="hof">
                <ul id="pv-labels"></ul>
                <ul id="pv-buttons">
                    <li><button id="pv-bar-prev" class="bar-button" type="button" title="previous (←)">${resource.ui('chevron-left')}</button></li>
                    <li id="pv-bar-idx" class="bar-label"></li>
                    <li><button id="pv-bar-next" class="bar-button" type="button" title="next (→)">${resource.ui('chevron-right')}</button></li>
                    <li><a id="pv-bar-raw" class="bar-button" target="_blank" rel="noopener" title="open original">${resource.ui('external')}</a></li>
                    <li><a id="pv-bar-download" class="bar-button" download title="download">${resource.ui('download')}</a></li>
                    <li><button id="pv-bar-fullscreen" class="bar-button" type="button" title="fullscreen (f)"></button></li>
                    <li><button id="pv-bar-close" class="bar-button" type="button" title="close (esc)">${resource.ui('close')}</button></li>
                </ul>
            </div>
        </div>`;
const storekey = 'ext/preview';

let isFullscreen = store.get(storekey) || false;
let userAliveTimeoutId = null;
let spinnerIsVisible = false;
let spinnerTimeoutId = null;
let session = null;
let lastFocus = null;
let touchStartX = null;


const updateGui = () => {
    if (isFullscreen) {
        dom('#pv-overlay').addCls('fullscreen');
        dom('#pv-bar-fullscreen').html(resource.ui('fullscreen-exit'));
    } else {
        dom('#pv-overlay').rmCls('fullscreen');
        dom('#pv-bar-fullscreen').html(resource.ui('fullscreen'));
    }

    if (isFn(session && session.adjust)) {
        session.adjust();
    }
};

const setIndex = (idx, total) => {
    dom('#pv-bar-idx').text(`${idx} / ${total}`).show();
};

const setRawLink = href => {
    dom('#pv-bar-raw').attr('href', href);
    dom('#pv-bar-download').attr('href', href);
};

const setLabels = labels => {
    const $labels = dom('#pv-labels').clr();
    each(labels, (label, idx) => {
        dom('<li class="bar-label"></li>')
            .addCls(idx === '0' || idx === 0 ? 'title' : 'meta')
            .text(label)
            .appTo($labels);
    });
};

const userAlive = () => {
    const $hof = dom('#pv-overlay .hof');

    win.clearTimeout(userAliveTimeoutId);
    $hof.rmCls('faded');

    if (isFullscreen) {
        userAliveTimeoutId = win.setTimeout(() => $hof.addCls('faded'), 2000);
    }
};

const next = () => session && session.moveIdx(1);
const prev = () => session && session.moveIdx(-1);

const toggleFullscreen = () => {
    isFullscreen = !isFullscreen;
    store.put(storekey, isFullscreen);

    userAlive();
    updateGui();
};

const dropEvent = ev => {
    ev.stopPropagation();
    ev.preventDefault();
};

// role=dialog aria-modal: Tab cycles inside the overlay
const trapTab = ev => {
    const overlay = dom('#pv-overlay')[0];
    const focusables = Array.from(overlay.querySelectorAll('button, a[href], video, audio, [tabindex]:not([tabindex="-1"])'))
        .filter(el => el.offsetParent !== null && !el.disabled);
    if (!focusables.length) {
        return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = win.document.activeElement;
    if (ev.shiftKey && (active === first || !overlay.contains(active))) {
        ev.preventDefault();
        last.focus();
    } else if (!ev.shiftKey && (active === last || !overlay.contains(active))) {
        ev.preventDefault();
        first.focus();
    }
};

const onKeydown = ev => {
    const key = ev.key;

    if (key === 'Tab') {
        trapTab(ev);
        return;
    }
    if (key === 'Escape') {
        dropEvent(ev);
        exit(); // eslint-disable-line no-use-before-define
    } else if (key === 'ArrowLeft' || key === 'Backspace' || key === 'PageUp') {
        dropEvent(ev);
        prev();
    } else if (key === 'ArrowRight' || key === 'PageDown' || (key === ' ' && ev.target.tagName !== 'VIDEO' && ev.target.tagName !== 'AUDIO')) {
        dropEvent(ev);
        next();
    } else if (key === 'f' || key === 'F') {
        dropEvent(ev);
        toggleFullscreen();
    }
};

const enter = () => {
    lastFocus = win.document.activeElement;
    setLabels([]);
    dom('#pv-container').clr();
    dom('#pv-overlay').show();
    dom('html').addCls('pv-open');
    dom(win).on('keydown', onKeydown);
    dom('#pv-overlay')[0].focus();
    updateGui();
};

const exit = () => {
    each(dom('#pv-container *'), el => {
        if (typeof el.unload === 'function') {
            el.unload();
        }
    });
    setLabels([]);
    dom('#pv-container').clr();
    dom('#pv-overlay').hide();
    dom('html').rmCls('pv-open');
    dom(win).off('keydown', onKeydown);
    session = null;
    if (lastFocus && lastFocus.focus) {
        lastFocus.focus();
    }
};

const showSpinner = (show, src, delay) => {
    win.clearTimeout(spinnerTimeoutId);

    const $spinner = dom('#pv-spinner');

    if (!show) {
        spinnerIsVisible = false;
        $spinner.hide();
        return;
    }

    if (!spinnerIsVisible && delay) {
        spinnerTimeoutId = win.setTimeout(() => showSpinner(true, src), delay);
        return;
    }

    const $back = $spinner.find('.back');
    if (src) {
        $back.attr('src', src).show();
    } else {
        $back.hide();
    }

    spinnerIsVisible = true;
    $spinner.show();
};

const Session = (items, idx, load, adjust) => {
    const inst = Object.assign(Object.create(Session.prototype), {items, load, adjust});
    inst.setIdx(idx);
    return inst;
};

Session.prototype = {
    setIdx(idx) {
        this.idx = (idx + this.items.length) % this.items.length;
        this.item = this.items[this.idx];

        setIndex(this.idx + 1, this.items.length);
        setRawLink(this.item.absHref);
        setLabels([this.item.label]);

        const item = this.item;

        Promise.resolve()
            .then(() => {
                each(dom('#pv-container *'), el => {
                    if (typeof el.unload === 'function') {
                        el.unload();
                    }
                });
                dom('#pv-container').hide().clr();
                showSpinner(true, item.thumbSquare || item.icon, 200);
            })
            .then(() => this.load(item))
            .then($content => {
                if (item === this.item && session === this) {
                    dom('#pv-container').clr().app($content).show();
                    showSpinner(false);
                    updateGui();
                }
            });
    },

    moveIdx(delta) {
        this.setIdx(this.idx + delta);
    }
};

const registeredTypes = [];

// Previews are off for download-only accounts and when the admin chose "always download".
const previewsEnabled = () => {
    const site = ((require('../../config').setup || {}).SITE || {});
    return !require('../../core/user').isAnon() && site.clickAction !== 'download';
};

const handles = item => !!item && previewsEnabled() && includes(registeredTypes, item.type);

const register = (types, load, adjust) => {
    if (!previewsEnabled()) {
        return;
    }
    registeredTypes.push(...types);
    const initItem = item => {
        if (item.$view && includes(types, item.type)) {
            item.$view.find('a.main').on('click', ev => {
                if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1) {
                    return; // let the browser open the file in a new tab/window
                }
                ev.preventDefault();

                const matchedItems = compact(dom('#items .item').map(el => {
                    const matchedItem = el._item;
                    return includes(types, matchedItem.type) ? matchedItem : null;
                }));

                session = Session(matchedItems, matchedItems.indexOf(item), load, adjust);
                enter();
            });
        }
    };

    event.sub('view.changed', added => each(added, initItem));
};

const init = () => {
    if (!settings.enabled) {
        return;
    }

    dom(overlayTpl)
        .hide()
        .appTo('body')
        .on('mousemove', userAlive)
        .on('mousedown', userAlive)
        .on('click', ev => {
            if (ev.target.id === 'pv-overlay' || ev.target.id === 'pv-container') {
                exit();
            }
        })
        .on('touchstart', ev => {
            touchStartX = ev.touches.length === 1 ? ev.touches[0].clientX : null;
        })
        .on('touchend', ev => {
            if (touchStartX !== null && ev.changedTouches.length === 1) {
                const dx = ev.changedTouches[0].clientX - touchStartX;
                if (Math.abs(dx) > 60) {
                    if (dx > 0) {
                        prev();
                    } else {
                        next();
                    }
                }
            }
            touchStartX = null;
        });

    dom('#pv-spinner').hide();
    dom('#pv-bar-prev, #pv-prev-area').on('click', ev => {
        dropEvent(ev);
        prev();
    });
    dom('#pv-bar-next, #pv-next-area').on('click', ev => {
        dropEvent(ev);
        next();
    });
    dom('#pv-bar-close').on('click', exit);
    dom('#pv-bar-fullscreen').on('click', toggleFullscreen);

    dom(win).on('resize', updateGui);
};


module.exports = {
    setLabels,
    register,
    handles,
    get item() {
        return session && session.item;
    }
};

init();

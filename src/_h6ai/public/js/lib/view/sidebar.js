const {dom} = require('../util');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const store = require('../core/store');
const base = require('./base');

const win = global.window;
const settings = Object.assign({
    disableSidebar: false
}, allsettings.view);
const storekey = 'sidebarIsVisible';
const sidebarTpl =
        `<aside id="sidebar" aria-labelledby="sidebar-title">
            <div class="sidebar-head">
                <h2 id="sidebar-title">Settings</h2>
                <button class="sidebar-close bar-button" type="button" aria-label="Close settings">${resource.ui('close')}</button>
            </div>
            <div id="sidebar-blocks"></div>
            <p id="backlink">h6ai</p>
        </aside>`;
const scrimTpl = '<div id="sidebar-scrim" hidden></div>';
const toggleTpl =
        `<button id="sidebar-toggle" class="tool" type="button" title="Settings" aria-label="Settings" aria-controls="sidebar">
            ${resource.ui('settings')}
        </button>`;

// on small screens the drawer overlays the list and needs a scrim and focus handling
const isOverlay = () => win.matchMedia('(max-width: 720px)').matches;

const init = () => {
    const $sidebar = dom(sidebarTpl).hide();
    const $scrim = dom(scrimTpl);
    const $toggle = dom(toggleTpl);

    const update = toggle => {
        let isVisible = store.get(storekey);

        if (toggle) {
            isVisible = !isVisible;
            store.put(storekey, isVisible);
        }

        $toggle.attr('aria-expanded', isVisible ? 'true' : 'false');
        if (isVisible) {
            $toggle.addCls('active');
            $sidebar.show();
            if (isOverlay()) {
                $scrim.rmAttr('hidden');
                if (toggle) {
                    $sidebar.find('.sidebar-close')[0].focus();
                }
            }
        } else {
            $toggle.rmCls('active');
            $sidebar.hide();
            $scrim.attr('hidden', '');
            if (toggle && isOverlay()) {
                $toggle[0].focus();
            }
        }
    };

    if (!settings.disableSidebar) {
        $sidebar.appTo(base.$mainrow);
        $scrim.appTo(base.$mainrow).on('click', () => update(true));
        $toggle.appTo(base.$tools.prefs).on('click', () => update(true));
        $sidebar.find('.sidebar-close').on('click', () => update(true));
        dom(win).on('keydown', ev => {
            if (ev.key === 'Escape' && !$sidebar.isHidden() && isOverlay()) {
                update(true);
            }
        });
        // phones open the list, not a drawer that covers it
        if (isOverlay() && store.get(storekey)) {
            store.put(storekey, false);
        }
        update();
    }

    return {
        // settings blocks go here
        $el: $sidebar.find('#sidebar-blocks')
    };
};

module.exports = init();

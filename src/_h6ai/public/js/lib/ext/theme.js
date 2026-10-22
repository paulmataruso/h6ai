// Theme picker in the settings drawer. All themes are dark; the admin sets the site default,
// a visitor's own pick is remembered in their browser (applied before first paint by page.php).
const {dom, each} = require('../util');
const config = require('../config');
const store = require('../core/store');
const sidebar = require('../view/sidebar');
const SKINS = require('../core/skins.json');

const root = global.window.document.documentElement;
const site = (config.setup && config.setup.SITE) || {};
const siteSkin = site.theme || root.getAttribute('data-site-skin') || 'midnight';
const storekey = 'skin';

const blockTpl =
        `<div id="theme-settings" class="block">
            <h3 id="theme-label">Theme</h3>
            <div class="swatches" role="radiogroup" aria-labelledby="theme-label"></div>
        </div>`;
const swatchTpl =
        `<button class="swatch" type="button" role="radio">
            <span class="swatch-chips" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            <span class="swatch-name"></span>
        </button>`;

const apply = skin => {
    root.setAttribute('data-skin', skin);
    dom('#theme-settings .swatch').each(el => {
        const on = el.getAttribute('data-skin') === skin;
        el.setAttribute('aria-checked', on ? 'true' : 'false');
        el.classList.toggle('active', on);
    });
};

const init = () => {
    const $block = dom(blockTpl);
    const $list = $block.find('.swatches');

    each(SKINS, (info, key) => {
        const $swatch = dom(swatchTpl).attr('data-skin', key).attr('title', info.note);
        $swatch.find('.swatch-chips i').each((el, idx) => {
            el.style.background = info.swatch[idx];
        });
        $swatch.find('.swatch-name').text(info.label + (key === siteSkin ? ' (site default)' : ''));
        $swatch.on('click', () => {
            // picking the site default again stops overriding it
            store.put(storekey, key === siteSkin ? null : key);
            apply(key);
        });
        $swatch.appTo($list);
    });

    $block.appTo(sidebar.$el);
    apply(root.getAttribute('data-skin') || siteSkin);
};


init();

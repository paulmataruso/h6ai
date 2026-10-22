const {each, dom} = require('../util');
const event = require('../core/event');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const sidebar = require('./sidebar');
const base = require('./base');
const view = require('./view');

const settings = Object.assign({
    modeToggle: false
}, allsettings.view);
const settingsTpl =
        `<div id="viewmode-settings" class="block">
            <h3 class="l10n-view">View</h3>
            <div class="segmented" role="radiogroup" aria-label="view mode"></div>
        </div>`;
const modeTpl =
        `<button id="viewmode-[MODE]" class="button mode" type="button" role="radio" aria-checked="false" title="[MODE]">
            [ICON]<span class="l10n-[MODE]">[MODE]</span>
        </button>`;
const sizeTpl =
        `<label class="range">
            <span class="range-label"><span>Size</span><output id="viewmode-size-value"></output></span>
            <input id="viewmode-size" type="range" min="0" max="0" value="0">
        </label>`;
const toggleTpl =
        `<button id="viewmode-toggle" class="tool" type="button" title="Change view" aria-label="Change view"></button>`;

let modes;
let sizes;

const onChanged = (mode, size) => {
    dom('#viewmode-settings .mode').rmCls('active').attr('aria-checked', 'false');
    dom('#viewmode-' + mode).addCls('active').attr('aria-checked', 'true');
    dom('#viewmode-size').val(sizes.indexOf(size));
    dom('#viewmode-size-value').text(`${sizes.indexOf(size) + 1} / ${sizes.length}`);

    if (settings.modeToggle === 'next') {
        mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    }
    dom('#viewmode-toggle').html(resource.ui('view-' + mode));
};

const addSettings = () => {
    if (modes.length < 2 && sizes.length < 2) {
        return;
    }

    const $viewBlock = dom(settingsTpl);
    const $segmented = $viewBlock.find('.segmented');

    if (modes.length > 1) {
        each(modes, mode => {
            dom(modeTpl.replace(/\[MODE\]/g, mode).replace('[ICON]', resource.ui('view-' + mode)))
                .on('click', () => {
                    view.setMode(mode);
                })
                .appTo($segmented);
        });
    } else {
        $segmented.rm();
    }

    if (sizes.length > 1) {
        const max = sizes.length - 1;
        const $size = dom(sizeTpl);
        $size.find('input')
            .attr('max', max)
            .on('input', ev => view.setSize(sizes[ev.target.valueAsNumber]))
            .on('change', ev => view.setSize(sizes[ev.target.valueAsNumber]));
        $size.appTo($viewBlock);
    }

    $viewBlock.appTo(sidebar.$el);
};

const onToggle = () => {
    const mode = view.getMode();
    const nextIdx = (modes.indexOf(mode) + 1) % modes.length;
    const nextMode = modes[nextIdx];

    view.setMode(nextMode);
};

const addToggle = () => {
    if (settings.modeToggle && modes.length > 1) {
        dom(toggleTpl)
            .on('click', onToggle)
            .appTo(base.$tools.prefs);
    }
};

const init = () => {
    modes = view.getModes();
    sizes = view.getSizes();

    addSettings();
    addToggle();

    onChanged(view.getMode(), view.getSize());
    event.sub('view.mode.changed', onChanged);
};


init();

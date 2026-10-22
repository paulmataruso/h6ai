const {dom} = require('../../util');
const format = require('../../core/format');
const allsettings = require('../../core/settings');
const preview = require('./preview');

const settings = Object.assign({
    enabled: false,
    autoplay: true,
    types: []
}, allsettings['preview-aud']);
const tpl = '<audio id="pv-content-aud" preload="metadata" controls></audio>';

const updateGui = () => {
    const el = dom('#pv-content-aud')[0];
    if (!el) {
        return;
    }

    preview.setLabels([
        preview.item.label,
        format.formatDuration(el.duration)
    ]);
};

const addUnloadFn = el => {
    el.unload = () => {
        el.pause();
        el.removeAttribute('src');
        el.load();
    };
};

const load = item => {
    return new Promise(resolve => {
        const $el = dom(tpl)
            .on('loadedmetadata', () => resolve($el))
            .on('error', () => resolve(require('./preview-error')(item, 'This audio format can\'t be played in the browser.')));

        if (settings.autoplay) {
            $el.attr('autoplay', 'autoplay');
        }

        addUnloadFn($el[0]);
        $el.attr('src', item.absHref);
    });
};

const init = () => {
    if (settings.enabled) {
        preview.register(settings.types, load, updateGui);
    }
};


init();

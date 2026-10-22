const event = require('../core/event');
const allsettings = require('../core/settings');

const doc = global.window.document;
const settings = Object.assign({
    enabled: false
}, allsettings.title);

const siteName = ((require('../config').setup || {}).SITE || {}).name || 'h6ai';

const onLocationChanged = item => {
    const labels = item.getCrumb().map(i => i.label);
    // "folder · site", most specific first for tabs and bookmarks
    labels.shift();
    doc.title = labels.length ? `${labels[labels.length - 1]} · ${siteName}` : siteName;
};

const init = () => {
    if (!settings.enabled) {
        return;
    }

    event.sub('location.changed', onLocationChanged);
};

init();

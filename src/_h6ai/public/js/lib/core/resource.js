const {includes} = require('../util');
const config = require('../config');
const settings = require('./settings');
const icons = require('./icons');

const imagesHref = settings.publicHref + 'images/';
const themesHref = imagesHref + 'themes/';
const defaultThemeHref = themesHref + 'default/';
const defaultIcons = ['file', 'folder', 'folder-page', 'folder-parent', 'ar', 'aud', 'bin', 'img', 'txt', 'vid', 'x'];

// UI icon as inline SVG markup (follows the colour theme)
const ui = (id, label) => icons.icon(id, label);

// File type icon URL from the configured theme
const icon = id => {
    const baseId = (id || '').split('-')[0];
    const theme = config.theme || {};
    const href = theme[id] || theme[baseId];

    if (href) {
        return themesHref + href;
    }

    if (includes(defaultIcons, id)) {
        return defaultThemeHref + id + '.svg';
    }

    if (includes(defaultIcons, baseId)) {
        return defaultThemeHref + baseId + '.svg';
    }

    return defaultThemeHref + 'file.svg';
};

module.exports = {
    ui,
    icon
};

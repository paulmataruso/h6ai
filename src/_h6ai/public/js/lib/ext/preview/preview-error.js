// Preview fallback when the browser can't render a file: say so and offer the download.
const {dom} = require('../../util');
const format = require('../../core/format');
const resource = require('../../core/resource');

module.exports = (item, message) => {
    const $el = dom(`<div class="pv-error">
            <p class="pv-error-text"></p>
            <a class="btn download-btn" download>${resource.ui('download')}<span></span></a>
        </div>`);
    $el.find('.pv-error-text').text(message);
    const size = format.formatSize(item.size);
    $el.find('a').attr('href', item.absHref).on('click', () => require('../download-notice').fileStarted(item));
    $el.find('a span').text(size ? `Download ${size}` : 'Download');
    return $el;
};

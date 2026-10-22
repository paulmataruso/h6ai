const {each, dom} = require('../util');
const {sanitizeHtml, markdownToHtml} = require('../util/sanitize');
const server = require('../server');
const event = require('../core/event');
const allsettings = require('../core/settings');

const settings = Object.assign({
    enabled: false,
    allowUnsafeHtml: false
}, allsettings.custom);

const render = ({content, type}) => {
    if (type === 'md') {
        return markdownToHtml(content);
    }
    return settings.allowUnsafeHtml ? content : sanitizeHtml(content);
};

const update = (data, key) => {
    const $el = dom(`#content-${key}`);

    if (data && data[key] && data[key].content) {
        $el.html(render(data[key])).show();
    } else {
        $el.clr().hide();
    }
};

const onLocationChanged = item => {
    server.request({action: 'get', custom: item.absHref}, {quiet: true}).then(response => {
        const data = response && response.custom;
        each(['header', 'footer'], key => update(data, key));
    });
};

const init = () => {
    if (!settings.enabled) {
        return;
    }

    dom('<div id="content-header" class="custom-content"></div>').hide().preTo('#content');
    dom('<div id="content-footer" class="custom-content"></div>').hide().appTo('#content');

    event.sub('location.changed', onLocationChanged);
};


init();

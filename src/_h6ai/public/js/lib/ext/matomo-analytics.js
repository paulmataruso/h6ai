const {dom} = require('../util');
const event = require('../core/event');
const allsettings = require('../core/settings');

const win = global.window;
// "piwik-analytics" is the pre-rename key, still honoured
const settings = Object.assign({
    enabled: false,
    baseURL: 'not-set',
    idSite: 0
}, allsettings['piwik-analytics'], allsettings['matomo-analytics']);

const init = () => {
    if (!settings.enabled) {
        return;
    }

    // reference: https://developer.matomo.org/guides/tracking-javascript-guide
    const baseUrl = 'https://' + String(settings.baseURL).replace(/^https?:\/\//, '').replace(/\/+$/, '') + '/';
    const paq = win._paq = win._paq || [];
    paq.push(['setTrackerUrl', baseUrl + 'matomo.php']);
    paq.push(['setSiteId', String(settings.idSite)]);
    paq.push(['enableLinkTracking']);

    dom('<script async></script>').attr('src', baseUrl + 'matomo.js').appTo('head');

    event.sub('location.changed', item => {
        paq.push(['setCustomUrl', win.location.href]);
        paq.push(['setDocumentTitle', item.getCrumb().map(i => i.label).join(' > ')]);
        paq.push(['trackPageView']);
    });
};


init();

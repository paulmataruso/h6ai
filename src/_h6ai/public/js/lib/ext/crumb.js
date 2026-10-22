const {each, dom} = require('../util');
const event = require('../core/event');
const location = require('../core/location');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const base = require('../view/base');

const settings = Object.assign({
    enabled: false
}, allsettings.crumb);
const crumbbarTpl = '<ol id="crumbbar"></ol>';
const crumbTpl =
        `<li class="crumb-item">
            <span class="sep">${resource.ui('chevron-right')}</span>
            <a class="crumb"><span class="label"></span></a>
        </li>`;
const pageHintTpl =
        `<img class="hint" src="${resource.icon('folder-page')}" alt="has index page">`;

const createHtml = item => {
    const $html = dom(crumbTpl);
    const $a = $html.find('a');
    location.setLink($a, item);

    const $label = $html.find('.label').text(item.label);
    if (item.isRoot() || item.isDomain()) {
        $label.addCls('root');
        dom(resource.ui('home')).preTo($a);
        $a.attr('aria-label', 'Home');
    }

    if (item.isCurrentFolder()) {
        $html.addCls('active');
        $a.attr('aria-current', 'page');
    }

    if (!item.isManaged) {
        $a.app(dom(pageHintTpl));
    }

    item._$crumb = $html;
    $html[0]._item = item;

    return $html;
};

const onLocationChanged = item => {
    const $crumb = item._$crumb;
    const $crumbbar = dom('#crumbbar');

    if ($crumb && $crumb.parent()[0] === $crumbbar[0]) {
        $crumbbar.children().rmCls('active');
        $crumbbar.find('a').rmAttr('aria-current');
        $crumb.addCls('active');
        $crumb.find('a').attr('aria-current', 'page');
    } else {
        $crumbbar.clr();
        each(item.getCrumb(), crumbItem => {
            $crumbbar.app(createHtml(crumbItem));
        });
    }
    // keep the current folder visible on narrow screens
    $crumbbar[0].scrollLeft = $crumbbar[0].scrollWidth;
};

const init = () => {
    if (!settings.enabled) {
        return;
    }

    dom(crumbbarTpl).appTo(base.$flowbar);
    event.sub('location.changed', onLocationChanged);
};


init();

const {dom} = require('../util');
const config = require('../config');

const SEL_ROOT = 'body';
// Tool groups keep DOM order = visual order = tab order:
// find (filter, search) · output (archive download) · preferences (view, settings) · account
const TPL_TOPBAR =
        `<header id="topbar">
            <a id="brand" href="/">
                <img class="brand-mark" alt="" width="28" height="28">
                <span class="brand-word">h6ai</span>
                <span class="brand-site"></span>
            </a>
            <nav id="flowbar" aria-label="Breadcrumb"></nav>
            <div id="toolbar" role="toolbar" aria-label="Tools">
                <div id="tools-find" class="tool-group"></div>
                <div id="tools-output" class="tool-group"></div>
                <div id="tools-prefs" class="tool-group"></div>
                <div id="tools-account" class="tool-group"></div>
            </div>
        </header>`;
const TPL_MAINROW =
        `<div id="mainrow">
            <main id="content" tabindex="-1">
                <h1 id="folder-title" class="visually-hidden"></h1>
            </main>
        </div>`;

const init = () => {
    const $root = dom(SEL_ROOT)
        .attr('id', 'root')
        .clr()
        .app(TPL_TOPBAR)
        .app(TPL_MAINROW);

    const setup = config.setup || {};
    const site = setup.SITE || {};
    const siteName = site.name && site.name !== 'h6ai' ? site.name : '';
    const $brand = $root.find('#brand')
        .attr('href', setup.ROOT_HREF || '/')
        .attr('aria-label', siteName ? `${siteName}, home` : 'h6ai, home');
    $brand.find('.brand-mark').attr('src', (setup.PUBLIC_HREF || '/_h6ai/public/') + 'images/brand/logo-mark.svg');
    // the operator's site name sits beside the h6ai wordmark, it never replaces it
    $brand.find('.brand-site').text(siteName);
    if (!siteName) {
        $brand.find('.brand-site').rm();
    }

    return {
        $root,
        $topbar: $root.find('#topbar'),
        $toolbar: $root.find('#toolbar'),
        $tools: {
            find: $root.find('#tools-find'),
            output: $root.find('#tools-output'),
            prefs: $root.find('#tools-prefs'),
            account: $root.find('#tools-account')
        },
        $flowbar: $root.find('#flowbar'),
        $mainrow: $root.find('#mainrow'),
        $content: $root.find('#content'),
        $title: $root.find('#folder-title')
    };
};

module.exports = init();

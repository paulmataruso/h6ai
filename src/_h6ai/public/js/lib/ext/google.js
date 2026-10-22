// Google Analytics / Tag Manager events for the single page app. The loaders themselves are
// rendered by the server (with a CSP nonce); this module reports virtual page views on fast
// browsing and file downloads, unless the server already reports downloads (Measurement
// Protocol), which also covers direct links that never touch this UI.
const {dom} = require('../util');
const config = require('../config');
const event = require('../core/event');

const win = global.window;
const google = (((config.setup || {}).SITE || {}).google) || {};
const hasGa = !!google.measurementId;
const hasGtm = !!google.tagManagerId;

const push = (name, params) => {
    if (hasGa && typeof win.gtag === 'function') {
        win.gtag('event', name, params);
    }
    if (hasGtm) {
        win.dataLayer = win.dataLayer || [];
        win.dataLayer.push(Object.assign({event: name}, params));
    }
};

let first = true;
const onLocationChanged = () => {
    if (first) {
        first = false; // the initial page view is sent by the loader's config call
        return;
    }
    push('page_view', {
        page_location: win.location.href,
        page_path: win.location.pathname,
        page_title: win.document.title
    });
};

const fileInfo = href => {
    const name = decodeURIComponent(href.split('/').pop() || '');
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return {file_name: name, file_extension: ext, link_url: new URL(href, win.location.href).href};
};

const onClick = ev => {
    const a = ev.target.closest && ev.target.closest('a[href]');
    if (!a || !a.closest('#items') || a.closest('.folder')) {
        return;
    }
    push('file_download', Object.assign(fileInfo(a.getAttribute('href')), {download_kind: 'file'}));
};

const init = () => {
    if (!hasGa && !hasGtm) {
        return;
    }
    // listeners registered after the page loader's own: virtual page views on fast browsing
    event.sub('location.changed', onLocationChanged);

    if (google.trackDownloads && !google.serverSideDownloads) {
        dom(win.document).on('click', onClick);
        event.sub('download.archive', href => push('file_download', Object.assign(fileInfo(href), {download_kind: 'archive'})));
    }
};


init();

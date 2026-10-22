const {each, dom} = require('./util');

const listeners = [];

// Called with (error message) whenever an API request fails, e.g. to show a notification.
const onError = fn => listeners.push(fn);

const fail = (msg, resp = {}) => {
    listeners.forEach(fn => fn(msg, resp));
    return Object.assign({err: resp.err || 'ERR_REQUEST', msg}, resp);
};

// POSTs a JSON request to the current folder URL. Always resolves; failed requests resolve to
// an object with `err` and `msg` (same shape as server side errors).
const request = (data, {quiet = false} = {}) => {
    return global.window.fetch('?', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json;charset=utf-8', 'Accept': 'application/json'},
        body: JSON.stringify(data)
    })
        .then(resp => resp.json().catch(() => ({err: 'ERR_RESPONSE', msg: `unexpected response (HTTP ${resp.status})`})))
        .then(json => {
            if (json && json.err && !quiet) {
                return fail(json.msg || json.err, json);
            }
            return json;
        })
        .catch(err => quiet ? {err: 'ERR_NETWORK', msg: String(err)} : fail(`network error: ${err.message || err}`));
};

// Downloads go through a regular form POST so the browser streams the response to disk.
const formRequest = data => {
    const $form = dom('<form method="post" action="?" hidden></form>');

    each(data, (val, key) => {
        dom('<input type="hidden">')
            .attr('name', key)
            .attr('value', val)
            .appTo($form);
    });

    $form.appTo('body');
    $form[0].submit();
    $form.rm();
};

module.exports = {
    request,
    formRequest,
    onError
};

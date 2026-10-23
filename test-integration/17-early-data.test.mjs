// TLS early data (0-RTT) can be replayed by anyone on the network path. nginx flags such a request
// (fastcgi_param HTTP_EARLY_DATA $ssl_early_data, in h6ai's server.conf); h6ai answers its API
// requests with 425, so the browser sends them again once the handshake is complete.
//
// A plain HTTP client can't send early data. Where nginx passes $ssl_early_data (h6ai's snippet),
// it replaces a client's own Early-Data header, so a login goes through; on a drop-in whose PHP
// location doesn't pass it, the client's header arrives and h6ai refuses. Either way nothing
// flagged as early data runs. test-native/dropin-custom.sh sends real early data over TLS 1.3.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api, sessionCookies, ADMIN_USER, ADMIN_PASS} from './lib.mjs';

test('an API request flagged as early data never runs', async () => {
    const r = await api({action: 'login', user: ADMIN_USER, pass: ADMIN_PASS}, {headers: {'Early-Data': '1'}});
    if (r.res.status === 425) {
        assert.equal(r.json.err, 'ERR_TOO_EARLY');
        assert.equal(sessionCookies(r.res).length, 0, 'a session was started');
    } else {
        // nginx replaced the header with $ssl_early_data (empty: no early data on this connection)
        assert.equal(r.res.status, 200, r.res.text.slice(0, 200));
        assert.equal(r.json.asAdmin, true);
    }
});

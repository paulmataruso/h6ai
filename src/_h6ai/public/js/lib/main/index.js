const notification = require('../view/notification');
require('../server').onError(msg => notification.error(msg));

require('../view/viewmode');
require('../ext/theme');
require('../ext/autorefresh');
require('../ext/crumb');
require('../ext/custom');
require('../ext/download');
require('../ext/filter');
require('../ext/info');
require('../ext/l10n');
require('../ext/matomo-analytics');
require('../ext/preview');
require('../ext/expand');
require('../ext/search');
require('../ext/select');
require('../ext/sort');
require('../ext/thumbnails');
require('../ext/title');
require('../ext/tree');
require('../ext/account');
require('../ext/keyboard');
require('../ext/google');

const href = global.window.document.location.href;
require('../core/location').setLocation(href, true);

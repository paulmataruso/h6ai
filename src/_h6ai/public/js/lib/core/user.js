// The logged in user as reported by the server (null for guests).
const config = require('../config');

const user = (config.setup && config.setup.USER) || null;

module.exports = {
    user,
    // download-only accounts: clicking a file downloads it, no in-browser previews
    isAnon: () => !!user && user.type === 'anon'
};

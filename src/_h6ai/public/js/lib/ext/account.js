const {dom} = require('../util');
const server = require('../server');
const config = require('../config');
const event = require('../core/event');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const base = require('../view/base');

const win = global.window;
const setup = config.setup || {};
const user = setup.USER || null;
const auth = setup.AUTH || {};

const loginTpl =
        `<dialog id="login-dialog" class="dialog" aria-labelledby="login-title">
            <form>
                <h2 id="login-title">Log in</h2>
                <p class="dialog-lead">Public folders don't need an account. Log in to see folders shared with you.</p>
                <label class="field"><span class="l10n-username">User name</span>
                    <input name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required>
                </label>
                <label class="field"><span class="l10n-password">Password</span>
                    <input name="pass" type="password" autocomplete="current-password" required>
                </label>
                <p class="dialog-error" role="alert" hidden></p>
                <div class="dialog-actions">
                    <button class="btn" type="button" value="cancel">Cancel</button>
                    <button class="btn primary l10n-login" type="submit">Log in</button>
                </div>
            </form>
        </dialog>`;
const passwordTpl =
        `<dialog id="password-dialog" class="dialog" aria-labelledby="password-title">
            <form>
                <h2 id="password-title" class="l10n-changePassword">Change password</h2>
                <label class="field"><span>Current password</span>
                    <input name="current" type="password" autocomplete="current-password" required>
                </label>
                <label class="field"><span>New password</span>
                    <input name="new" type="password" autocomplete="new-password" minlength="8" required>
                </label>
                <label class="field"><span>Repeat new password</span>
                    <input name="repeat" type="password" autocomplete="new-password" minlength="8" required>
                </label>
                <p class="dialog-error" role="alert" hidden></p>
                <div class="dialog-actions">
                    <button class="btn" type="button" value="cancel">Cancel</button>
                    <button class="btn primary" type="submit">Save</button>
                </div>
            </form>
        </dialog>`;
const buttonTpl = '<button id="account" class="tool" type="button" aria-haspopup="true" aria-expanded="false"></button>';
const menuTpl =
        `<div id="account-menu" class="menu" role="menu" hidden>
            <div class="menu-header"><span class="menu-user"></span><span class="menu-roles"></span></div>
            <a class="menu-item admin-link" role="menuitem">${resource.ui('shield')}<span class="l10n-admin">Admin</span></a>
            <button class="menu-item change-password" type="button" role="menuitem">${resource.ui('key')}<span class="l10n-changePassword">Change password</span></button>
            <button class="menu-item logout" type="button" role="menuitem">${resource.ui('log-out')}<span class="l10n-logout">Log out</span></button>
        </div>`;

const reload = () => win.location.reload();

const showError = ($dialog, msg) => {
    $dialog.find('.dialog-error').text(msg).rmAttr('hidden');
};

const wireDialog = ($dialog, onSubmit) => {
    const dialog = $dialog[0];
    $dialog.find('button[value="cancel"]').on('click', () => dialog.close());
    $dialog.find('form').on('submit', ev => {
        ev.preventDefault();
        $dialog.find('.dialog-error').attr('hidden', '');
        const $submit = $dialog.find('button[type="submit"]').prop('disabled', true);
        const data = Object.fromEntries(new win.FormData(ev.target).entries());
        Promise.resolve(onSubmit(data)).finally(() => $submit.prop('disabled', false));
    });
    dialog.addEventListener('close', () => {
        $dialog.find('form')[0].reset();
        $dialog.find('.dialog-error').attr('hidden', '');
    });
    return $dialog;
};

const openLogin = () => {
    const dialog = dom('#login-dialog')[0];
    if (dialog && !dialog.open) {
        dialog.showModal();
        dom(dialog).find('input[name="user"]')[0].focus();
    }
};

const initLogin = () => {
    const site = setup.SITE || {};
    const $login = dom(loginTpl);
    if (site.name && site.name !== 'h6ai') {
        $login.find('#login-title').text(`Log in to ${site.name}`);
    }
    const $dialog = wireDialog($login.appTo('body'), data => {
        return server.request({action: 'login', user: data.user, pass: data.pass}, {quiet: true}).then(resp => {
            if (resp.user) {
                reload();
            } else if (resp.err === 'ERR_RATE_LIMITED') {
                showError($dialog, 'Too many failed attempts. Please try again later.');
            } else {
                showError($dialog, resp.err ? resp.msg : 'Wrong user name or password.');
            }
        });
    });

    dom(buttonTpl)
        .html(resource.ui('log-in'))
        .attr('title', 'Log in').attr('aria-label', 'Log in').rmAttr('aria-haspopup').rmAttr('aria-expanded')
        .appTo(base.$tools.account)
        .on('click', openLogin);
    return $dialog;
};

const initUserMenu = () => {
    const $button = dom(buttonTpl)
        .addCls('avatar')
        .attr('title', user.name).attr('aria-label', 'Account: ' + user.name)
        .appTo(base.$tools.account);
    dom('<span class="avatar-letter"></span>').text(user.name.slice(0, 1).toUpperCase()).appTo($button);

    const $menu = dom(menuTpl).appTo(base.$topbar);
    $menu.find('.menu-user').text(user.name);
    $menu.find('.menu-roles').text(user.type === 'anon' ? 'download-only account' : user.roles.join(', '));

    if (user.isAdmin) {
        $menu.find('.admin-link').attr('href', allsettings.publicHref);
    } else {
        $menu.find('.admin-link').rm();
    }
    if (user.bootstrap || user.type === 'anon') {
        $menu.find('.change-password').rm();
    }

    const close = () => {
        $menu.attr('hidden', '');
        $button.attr('aria-expanded', 'false');
    };
    const toggle = ev => {
        ev.stopPropagation();
        if ($menu[0].hidden) {
            $menu.rmAttr('hidden');
            $button.attr('aria-expanded', 'true');
            const first = $menu.find('.menu-item')[0];
            if (first) {
                first.focus();
            }
        } else {
            close();
        }
    };

    $button.on('click', toggle);
    dom(win.document).on('click', ev => {
        if (!$menu[0].hidden && !$menu[0].contains(ev.target)) {
            close();
        }
    });
    $menu.on('keydown', ev => {
        if (ev.key === 'Escape') {
            close();
            $button[0].focus();
        }
    });

    $menu.find('.logout').on('click', () => {
        server.request({action: 'logout', csrf: setup.CSRF}).then(reload);
    });

    const $pwDialog = wireDialog(dom(passwordTpl).appTo('body'), data => {
        if (data.new !== data.repeat) {
            showError($pwDialog, 'The new passwords don\'t match.');
            return null;
        }
        return server.request({action: 'password', csrf: setup.CSRF, current: data.current, new: data.new}, {quiet: true}).then(resp => {
            if (resp.ok) {
                $pwDialog[0].close();
            } else {
                showError($pwDialog, resp.msg || 'Could not change the password.');
            }
        });
    });
    $menu.find('.change-password').on('click', () => {
        close();
        $pwDialog[0].showModal();
    });
};

// Shown in place of the listing when the server denied access to the current folder.
const onHint = (key, $hint) => {
    if (key !== 'denied') {
        return;
    }
    const item = require('../core/location').getItem();
    const needsLogin = item && item.denied === 'login' && auth.loginAvailable;
    $hint.clr().rmCls('l10n-denied');
    dom('<div class="denied-icon"></div>').html(resource.ui('lock')).appTo($hint);
    const $text = dom('<p></p>');
    if (item && item.denied === 'unavailable') {
        // anonymous mode: an excluded folder, there's no login to offer
        $text.text('This folder isn\'t available.');
    } else if (needsLogin) {
        $text.addCls('l10n-deniedLogin').text('This folder requires a login.');
    } else if (user && user.type === 'anon') {
        // no l10n class: the translated generic line would replace this account-specific one
        $text.text('This account only sees the folders that were shared with it.');
    } else {
        $text.addCls('l10n-denied').text('You don\'t have access to this folder.');
    }
    $text.appTo($hint);
    const $actions = dom('<div class="hint-actions"></div>').appTo($hint);
    if (needsLogin) {
        dom('<button class="btn primary" type="button">Log in</button>').on('click', openLogin).appTo($actions);
    } else if (user) {
        dom('<a class="btn">Go to your folders</a>').attr('href', setup.ROOT_HREF || '/').appTo($actions);
        dom('<button class="btn" type="button">Log in as someone else</button>')
            .on('click', () => server.request({action: 'logout', csrf: setup.CSRF}).then(reload))
            .appTo($actions);
    }
};

const init = () => {
    event.sub('view.hint', onHint);

    if (user) {
        initUserMenu();
    } else if (auth.loginAvailable && !auth.anonymous) {
        initLogin();
    }
};


init();

module.exports = {
    openLogin
};

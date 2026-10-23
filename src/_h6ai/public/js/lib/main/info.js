// Admin page (/_h6ai/public/): login, users, folder groups, folder rules, roles, Google & SEO,
// activity log and system checks.
const {dom, each} = require('../util');
const config = require('../config');
const server = require('../server');
const resource = require('../core/resource');
const store = require('../core/store');
const format = require('../core/format');
const {copyText} = require('../util/clipboard');

const win = global.window;
const doc = win.document;
const setup = config.setup || {};
const user = setup.USER || null;
const auth = setup.AUTH || {};
const site = setup.SITE || {};
const LEVELS = ['none', 'list', 'read', 'download'];
const LEVEL_HELP = {
    none: 'hidden, no access',
    list: 'see names, can\'t open files',
    read: 'open, preview and download single files',
    download: 'read + download folders as archive'
};
const TYPE_HELP = {
    standard: 'Standard: sees public folders plus everything granted to their roles and to them',
    anon: 'Anon (download only): sees nothing but their folder groups, no previews, can\'t change the password'
};

// --- tiny element helper, all text goes through textContent -------------------------------

const el = (tag, opts = {}, children = []) => {
    const node = doc.createElement(tag);
    if (opts.cls) {
        node.className = opts.cls;
    }
    if (opts.text !== undefined && opts.text !== null) {
        node.textContent = String(opts.text);
    }
    if (opts.html) {
        node.innerHTML = opts.html; // only used with trusted, static markup (icons)
    }
    each(opts.attrs || {}, (value, key) => {
        if (value !== false && value !== null && value !== undefined) {
            node.setAttribute(key, value === true ? '' : value);
        }
    });
    each(opts.props || {}, (value, key) => {
        node[key] = value;
    });
    each(opts.on || {}, (fn, type) => node.addEventListener(type, fn));
    (Array.isArray(children) ? children : [children]).forEach(child => {
        if (child) {
            node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
        }
    });
    return node;
};

const icon = (id, label) => el('span', {cls: 'icon-wrap', html: resource.ui(id, label)});
const button = (label, {cls = 'btn', iconId, title, onClick, type = 'button'} = {}) =>
    el('button', {cls, attrs: {type, title: title || null, 'aria-label': title || null}, on: onClick ? {click: onClick} : {}},
        [iconId ? icon(iconId) : null, label ? el('span', {text: label}) : null]);
const formatTime = ts => ts ? new Date(ts * 1000).toLocaleString() : '—';
const field = (label, input, help) => el('label', {cls: 'field'}, [el('span', {text: label}), input, help ? el('small', {cls: 'help', text: help}) : null]);
const check = (name, label, checked, help) => el('label', {cls: 'check'}, [
    el('input', {attrs: {type: 'checkbox', name, checked: !!checked}}),
    el('span', {text: label}),
    help ? el('small', {text: help}) : null
]);
// label: accessible name for selects that sit in a row without a visible <label>
const select = (name, options, value, label) => el('select', {attrs: label ? {name, 'aria-label': label} : {name}},
    options.map(([v, text]) => el('option', {text, attrs: {value: v, selected: v === value}})));
// table head; an empty title is the actions column, named for screen readers only
const headRow = titles => el('thead', {}, el('tr', {}, titles.map(t => t
    ? el('th', {text: t})
    : el('th', {}, el('span', {cls: 'visually-hidden', text: 'Actions'})))));

const toast = (msg, kind = 'info') => {
    let $toast = dom('#notification');
    if (!$toast.length) {
        $toast = dom('<div id="notification" role="status" aria-live="polite"></div>').appTo('body');
    }
    $toast.text(msg).rmCls('info', 'error').addCls(kind).show();
    win.clearTimeout(toast.timeoutId);
    toast.timeoutId = win.setTimeout(() => $toast.hide(), kind === 'error' ? 6000 : 3000);
};

server.onError(msg => toast(msg, 'error'));

const reload = () => win.location.reload();

// WAI-ARIA tabs: arrows / Home / End move between tabs and activate them
const arrowTabs = list => {
    list.addEventListener('keydown', ev => {
        const tabs = Array.from(list.querySelectorAll('[role=tab]'));
        const idx = tabs.indexOf(doc.activeElement);
        if (idx < 0 || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(ev.key)) {
            return;
        }
        ev.preventDefault();
        const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (idx + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus();
        tabs[next].click(); // render() puts focus back on the re-created tab
    });
    return list;
};

// render() rebuilds the page; a focused tab is found again by its data attribute
const focusedTab = () => {
    const active = doc.activeElement;
    if (!active || active.getAttribute('role') !== 'tab') {
        return null;
    }
    const attr = active.hasAttribute('data-tab') ? 'data-tab' : 'data-view';
    return `[role=tab][${attr}="${active.getAttribute(attr)}"]`;
};

// --- dialogs -------------------------------------------------------------------------------

const dialog = (title, body, {submitLabel = 'Save', onSubmit, wide = false} = {}) => {
    const error = el('p', {cls: 'dialog-error', attrs: {role: 'alert', hidden: true}});
    const node = el('dialog', {cls: 'dialog' + (wide ? ' wide' : '')});
    const form = el('form', {}, [
        el('h2', {text: title}),
        body,
        error,
        el('div', {cls: 'dialog-actions'}, [
            button('Cancel', {onClick: () => node.close()}),
            button(submitLabel, {cls: 'btn primary', type: 'submit'})
        ])
    ]);
    node.appendChild(form);
    form.addEventListener('submit', ev => {
        ev.preventDefault();
        error.hidden = true;
        Promise.resolve(onSubmit(new win.FormData(form), form)).then(result => {
            if (result && result.error) {
                error.textContent = result.error;
                error.hidden = false;
            } else if (result !== false) {
                node.close();
            }
        });
    });
    node.addEventListener('close', () => node.remove());
    doc.body.appendChild(node);
    node.showModal();
    const first = node.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first) {
        first.focus();
    }
    return node;
};

const confirmDialog = (title, text, onConfirm) => dialog(title, el('p', {text}), {
    submitLabel: 'Delete',
    onSubmit: () => onConfirm()
});

// --- admin api -----------------------------------------------------------------------------

let state = {users: [], roles: [], groups: [], rules: [], levels: LEVELS, writable: true, bootstrap: false};
let settings = null;
let requestInfo = null; // how the server sees this admin's request (reverse proxy setup)
let activity = null;
let activityFilter = {user: '', kind: '', path: ''};
const loading = {settings: false, activity: false};
let accessResult = null;

const adminRequest = (op, data = {}) => server.request(Object.assign({action: 'admin', op, csrf: setup.CSRF}, data), {quiet: true})
    .then(resp => {
        if (resp.err) {
            if (resp.err === 'ERR_FORBIDDEN' && op !== 'list') {
                // e.g. the bootstrap session ended after creating the first admin
                toast('Your session changed, please log in again.', 'error');
                win.setTimeout(reload, 1500);
            }
            return {error: resp.msg || resp.err};
        }
        if (resp.settings) {
            settings = resp.settings;
            requestInfo = resp.request || null;
        } else if (resp.access) {
            accessResult = resp.access;
        } else if (resp.entries) {
            activity = resp;
        } else {
            state = resp;
        }
        render(); // eslint-disable-line no-use-before-define
        return resp;
    });

// --- drop-in checks: run from the browser, so they test what the server actually does --------

const ERROR_PAGE_LINE = 'error_page 403 404 = /_h6ai/public/index.php;';
// null = not checked (yet)
const dropin = {exposed: null, routed: null, listed: null, fast: null, plainLocal: null, server: null};

const privateBanner = () => dropin.exposed ? el('div', {cls: 'banner error'}, [icon('lock'), el('span', {text:
    'Your server sends .php files from _h6ai/private/ as plain text, so anyone can download users, password hashes and ' +
    'settings. Let PHP run every .php file (the usual "location ~ \\.php$" block) or deny /_h6ai/private/ in nginx.'})]) : null;

// a hand-written options.local.json (maybe with the passhash) is served as text by a drop-in
const plainLocalBanner = () => dropin.plainLocal ? el('div', {cls: 'banner error'}, [icon('lock'), el('span', {}, [
    'Anyone can download _h6ai/private/conf/options.local.json. Rename it to ', el('code', {text: 'options.local.php'}),
    ' and put this line in front of its content: ', el('code', {text: '<?php http_response_code(404); exit; ?>'})])]) : null;

const routingBanner = () => (auth.dropin || setup.IS_DROPIN) && dropin.routed === false ? el('div', {cls: 'banner warn'}, [
    icon('info'), el('span', {}, ['nginx doesn\'t hand unknown paths to h6ai yet, so folders and files of the files folder ' +
        'can\'t be opened. Add this line to the server block and reload nginx: ', el('code', {text: ERROR_PAGE_LINE})])]) : null;

// Shared files inside the web root bypass h6ai: rules then only hide entries.
const dropinNote = () => setup.IS_DROPIN && setup.ROOT_IN_WEBROOT ? el('div', {cls: 'banner warn'}, [icon('info'), el('span', {text:
    'Your files are inside the web root: nginx hands them out without asking h6ai, so this only hides folders in ' +
    'listings, search and archives. See System → Drop-in install.'})]) : null;

const fetchText = url => win.fetch(url, {cache: 'no-store', credentials: 'omit', redirect: 'manual'})
    .then(resp => resp.text().then(text => ({status: resp.status, text, route: resp.headers.get('X-H6ai-Route'), server: resp.headers.get('Server')})))
    .catch(() => null);

const runChecks = () => {
    const pub = setup.PUBLIC_HREF || '/_h6ai/public/';
    const priv = pub.replace(/public\/$/, 'private/');
    const isDropin = auth.dropin || setup.IS_DROPIN;
    const jobs = [
        fetchText(priv + 'conf/canary.php').then(r => {
            dropin.exposed = !!r && r.text.includes('h6ai-canary');
        }),
        fetchText(priv + 'conf/options.local.json').then(r => {
            dropin.plainLocal = !!r && r.status === 200 && r.text.trim().startsWith('{');
        })
    ];
    if (isDropin) {
        jobs.push(
            fetchText((setup.ROOT_HREF || '/') + 'h6ai-route-check-' + Date.now() + '/').then(r => {
                dropin.routed = !!r && r.route === 'not-found';
                dropin.server = r && r.server ? r.server : '';
            }),
            fetchText(priv + 'cache/').then(r => {
                dropin.listed = !!r && (/x[sp]-[0-9a-f]{40}/).test(r.text);
            }),
            fetchText(pub + 'index.php?h6ai-probe=accel').then(r => {
                dropin.fast = !!r && r.text === 'h6ai-xaccel-ok\n';
            })
        );
    }
    Promise.all(jobs).then(() => {
        render(); // eslint-disable-line no-use-before-define
        if (isDropin && user && user.isAdmin) {
            // files go through nginx only once a browser saw X-Accel-Redirect work here
            adminRequest('settings.get').then(resp => {
                const current = resp.settings && resp.settings.dropin && resp.settings.dropin.fastDownloads === true;
                if (current !== (dropin.fast === true)) {
                    adminRequest('settings.save', {settings: {dropin: {fastDownloads: dropin.fast === true}}});
                }
            });
        }
    });
};

// --- login ---------------------------------------------------------------------------------

// First run, no password and no users yet (typically a drop-in install without a shell): the
// server hashes a password, the admin saves the result as options.local.php by hand. Saving
// that file proves they own the server; h6ai never writes it itself.
const firstRunCard = () => {
    const error = el('p', {cls: 'dialog-error', attrs: {role: 'alert', hidden: true}});
    const result = el('div', {cls: 'setup-result', attrs: {hidden: true}});
    const folderField = auth.dropin ? field('Files folder', el('input', {attrs: {name: 'filesFolder', required: true,
        autocomplete: 'off', spellcheck: 'false', placeholder: '/srv/files'}}),
    'The folder to share, outside the web root, readable for PHP. h6ai hands out every file in it itself.') : null;
    const form = el('form', {cls: 'login-form'}, [
        folderField,
        field('Password', el('input', {attrs: {name: 'pass', type: 'password', autocomplete: 'new-password', minlength: 8, required: true}}),
            'At least 8 characters. You log in as "admin" with it once, to create your own admin account.'),
        field('Repeat password', el('input', {attrs: {name: 'repeat', type: 'password', autocomplete: 'new-password', minlength: 8, required: true}})),
        error,
        button('Create the setup file', {cls: 'btn primary', type: 'submit', iconId: 'key'})
    ]);
    form.addEventListener('submit', ev => {
        ev.preventDefault();
        error.hidden = true;
        const data = new win.FormData(form);
        if (data.get('pass') !== data.get('repeat')) {
            error.textContent = 'The passwords don\'t match.';
            error.hidden = false;
            return;
        }
        server.request({action: 'passhash', pass: data.get('pass'), filesFolder: data.get('filesFolder') || ''}, {quiet: true}).then(resp => {
            if (!resp.file) {
                error.textContent = resp.msg || 'Could not create the setup file.';
                error.hidden = false;
                return;
            }
            const f = resp.folder;
            const name = data.get('filesFolder');
            const folderProblem = !f ? null : [
                f.insideWebRoot ? `${name} is inside the web root, where nginx hands files out without asking h6ai. Use a folder outside it.` : null,
                !f.exists ? `${name} doesn't exist yet. Create it before you reload.` : null,
                f.exists && !f.readable ? `PHP can't read ${name}. Make it readable for the PHP user.` : null
            ].filter(Boolean).join(' ') || null;
            const download = el('a', {cls: 'btn primary', text: 'Download options.local.php', attrs: {
                href: win.URL.createObjectURL(new win.Blob([resp.file], {type: 'application/octet-stream'})), download: 'options.local.php'}});
            result.innerHTML = '';
            [
                folderProblem ? el('div', {cls: 'banner warn'}, [icon('info'), el('span', {text: folderProblem})]) : null,
                el('h3', {text: 'Now put it on the server'}),
                el('ol', {cls: 'steps'}, [
                    el('li', {}, ['Save it as ', el('code', {text: '_h6ai/private/conf/options.local.php'}),
                        ' (FTP, file manager or shell). Its first line keeps it unreadable over the web.']),
                    el('li', {text: 'Reload this page and log in as "admin" with the password you just chose.'}),
                    el('li', {text: 'Create your own admin account on the Access tab. The setup password stops working then.'})
                ]),
                el('pre', {text: resp.file}),
                el('div', {cls: 'form-actions'}, [
                    button('Copy', {cls: 'btn', onClick: () => copyText(resp.file).then(ok => toast(ok ? 'Copied' : 'Copy failed', ok ? 'info' : 'error'))}),
                    download
                ])
            ].forEach(node => node && result.appendChild(node));
            result.hidden = false;
            form.hidden = true;
        });
    });
    return el('section', {cls: 'card narrow login-card'}, [
        el('img', {cls: 'login-logo', attrs: {src: setup.PUBLIC_HREF + 'images/brand/logo-mark.svg', alt: '', width: 56, height: 56}}),
        el('h2', {text: 'Set up h6ai'}),
        el('p', {cls: 'help', text: auth.dropin ? 'No admin exists yet. Tell h6ai which folder to share and choose a password for the first login.'
            : 'No admin exists yet. Choose a password for the first login.'}),
        form,
        result,
        el('div', {cls: 'shell-hint'}, [
            el('p', {cls: 'help', text: 'With a shell, as the web server\'s user, this works too:'}),
            el('pre', {text: 'php _h6ai/private/bin/h6ai-user.php add NAME --admin'})
        ])
    ]);
};

const loginCard = () => {
    if (!auth.loginAvailable) {
        return firstRunCard();
    }
    const error = el('p', {cls: 'dialog-error', attrs: {role: 'alert', hidden: true}});
    const form = el('form', {cls: 'login-form'}, [
        field('User name', el('input', {attrs: {name: 'user', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true}})),
        field('Password', el('input', {attrs: {name: 'pass', type: 'password', autocomplete: 'current-password', required: true}})),
        error,
        button('Log in', {cls: 'btn primary', type: 'submit', iconId: 'log-in'})
    ]);
    form.addEventListener('submit', ev => {
        ev.preventDefault();
        const data = new win.FormData(form);
        server.request({action: 'login', user: data.get('user'), pass: data.get('pass')}, {quiet: true}).then(resp => {
            if (resp.user) {
                reload();
            } else {
                error.textContent = resp.err === 'ERR_RATE_LIMITED' ? 'Too many failed attempts, try again later.' : (resp.msg || 'Wrong user name or password.');
                error.hidden = false;
            }
        });
    });
    return el('section', {cls: 'card narrow login-card'}, [
        el('img', {cls: 'login-logo', attrs: {src: setup.PUBLIC_HREF + 'images/brand/logo-mark.svg', alt: '', width: 56, height: 56}}),
        el('h2', {text: `Log in to ${site.name || 'h6ai'}`}),
        auth.anonymous ? el('p', {cls: 'help', text: 'Anonymous mode is on: only admins sign in.'}) : null,
        form
    ]);
};

// --- folder picker (lists folders through the regular items API) ----------------------------

const folderPicker = (initial, onChange) => {
    const list = el('ul', {cls: 'picker-list'});
    const crumb = el('div', {cls: 'picker-crumb'});
    let current = '/';
    const open = href => {
        server.request({action: 'get', items: {href, what: 1}}, {quiet: true}).then(resp => {
            current = decodeURIComponent(href).slice(setup.ROOT_HREF.length - 1) || '/';
            crumb.textContent = current;
            onChange(current);
            list.innerHTML = '';
            const children = (resp.items || []).filter(i => i.href !== href && i.href.startsWith(href) && i.href.endsWith('/') &&
                i.href.slice(href.length).split('/').length === 2);
            if (href !== setup.ROOT_HREF) {
                const parent = href.replace(/[^/]+\/$/, '');
                list.appendChild(el('li', {}, button('..', {cls: 'btn link', iconId: 'back', onClick: () => open(parent)})));
            }
            children.forEach(child => {
                const name = decodeURIComponent(child.href.slice(href.length, -1));
                list.appendChild(el('li', {}, button(name, {cls: 'btn link', iconId: 'folder', onClick: () => open(child.href)})));
            });
            if (!children.length) {
                list.appendChild(el('li', {cls: 'muted', text: 'no subfolders'}));
            }
        });
    };
    const start = setup.ROOT_HREF + (initial || '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
    open(start.endsWith('/') ? start : start + '/');
    return {node: el('div', {cls: 'picker'}, [crumb, list]), current: () => current};
};

// --- folder access editor (folder group + level rows) ----------------------------------------

const accessEditor = initial => {
    const rows = el('div', {cls: 'grants'});
    const groupOptions = () => state.groups.map(g => [g.name, g.name + (g.description ? ` — ${g.description}` : '')]);
    const addRow = (group, level) => {
        const row = el('div', {cls: 'grant-row access-row'}, [
            select('group', groupOptions(), group, 'Folder group'),
            select('level', LEVELS.filter(l => l !== 'none').map(l => [l, `${l} — ${LEVEL_HELP[l]}`]), level, 'Access level'),
            button(null, {cls: 'btn icon danger', iconId: 'trash', title: 'Remove', onClick: () => row.remove()})
        ]);
        rows.appendChild(row);
    };
    (initial || []).forEach(a => addRow(a.group, a.level));

    const node = el('div', {cls: 'field'}, [
        el('span', {cls: 'field-label', text: 'Folder access'}),
        state.groups.length
            ? el('p', {cls: 'help', text: 'Grant access to folder groups. Every folder in the group (and everything below it) gets the chosen level.'})
            : el('p', {cls: 'help', text: 'No folder groups yet. Create them on the "Folder groups" tab first.'}),
        rows,
        state.groups.length ? button('Add folder group', {cls: 'btn', iconId: 'plus', onClick: () => addRow(state.groups[0].name, 'download')}) : null
    ]);
    const value = () => Array.from(rows.querySelectorAll('.access-row')).map(row => ({
        group: row.querySelector('[name=group]').value,
        level: row.querySelector('[name=level]').value
    }));
    return {node, value};
};

const accessChips = access => (access || []).map(a => el('span', {cls: 'chip level-' + a.level, text: `${a.group}: ${a.level}`}));

// --- users ---------------------------------------------------------------------------------

const userDialog = existing => {
    const isNew = !existing;
    const type = isNew ? 'standard' : existing.type;
    const roleChecks = state.roles.map(role => check('roles', role.name,
        isNew ? role.name === 'user' : existing.roles.includes(role.name), role.description));
    roleChecks.forEach((label, idx) => label.querySelector('input').setAttribute('value', state.roles[idx].name));
    const rolesField = el('fieldset', {cls: 'field'}, [el('legend', {text: 'Roles'}), ...roleChecks]);
    const typeSelect = select('type', [['standard', 'Standard'], ['anon', 'Anon — download only']], type);
    const typeHelp = el('small', {cls: 'help', text: TYPE_HELP[type]});
    const syncType = () => {
        const anon = typeSelect.value === 'anon';
        typeHelp.textContent = TYPE_HELP[typeSelect.value];
        rolesField.hidden = anon;
    };
    typeSelect.addEventListener('change', syncType);
    const access = accessEditor(isNew ? [] : existing.access);

    const body = el('div', {cls: 'fields'}, [
        field('User name', el('input', {attrs: {name: 'name', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._@\\-]{0,63}',
            value: isNew ? '' : existing.name, readonly: !isNew, autocomplete: 'off'}})),
        field(isNew ? 'Password' : 'New password (leave empty to keep)',
            el('input', {attrs: {name: 'password', type: 'password', minlength: 8, required: isNew, autocomplete: 'new-password'}})),
        el('label', {cls: 'field'}, [el('span', {text: 'Account type'}), typeSelect, typeHelp]),
        rolesField,
        access.node,
        check('disabled', 'Disabled (can\'t log in, sessions end immediately)', !isNew && existing.disabled)
    ]);
    syncType();
    dialog(isNew ? 'Add user' : `Edit ${existing.name}`, body, {
        wide: true,
        onSubmit: data => adminRequest('user.save', {user: {
            name: data.get('name'),
            password: data.get('password') || null,
            type: data.get('type'),
            roles: data.get('type') === 'anon' ? [] : data.getAll('roles'),
            access: access.value(),
            disabled: data.get('disabled') === 'on',
            create: isNew
        }}).then(resp => resp.error ? resp : toast(isNew ? 'User created' : 'User saved'))
    });
};

const usersPanel = () => {
    const rows = state.users.map(u => el('tr', {cls: u.disabled ? 'muted' : ''}, [
        el('td', {}, [el('strong', {text: u.name}), user && u.name === user.name ? el('span', {cls: 'chip', text: 'you'}) : null]),
        el('td', {}, el('span', {cls: 'chip' + (u.type === 'anon' ? ' warn' : ''), text: u.type === 'anon' ? 'anon' : 'standard'})),
        el('td', {}, u.roles.map(r => el('span', {cls: 'chip' + (r === 'admin' ? ' accent' : ''), text: r}))),
        el('td', {}, u.type === 'anon' && !u.access.length
            ? el('span', {cls: 'chip warn', text: 'no folders shared: sees nothing yet'})
            : accessChips(u.access)),
        el('td', {text: u.disabled ? 'disabled' : 'active'}),
        el('td', {text: formatTime(u.lastLogin)}),
        el('td', {cls: 'actions'}, [
            button(null, {cls: 'btn icon', iconId: 'edit', title: `Edit ${u.name}`, onClick: () => userDialog(u)}),
            button(null, {cls: 'btn icon danger', iconId: 'trash', title: `Delete ${u.name}`,
                onClick: () => confirmDialog('Delete user', `Delete user "${u.name}"? Their permission grants are removed too.`,
                    () => adminRequest('user.delete', {name: u.name}))})
        ])
    ]));

    return el('section', {cls: 'card'}, [
        el('div', {cls: 'card-head'}, [
            el('h2', {text: 'Users'}),
            button('Add user', {cls: 'btn primary', iconId: 'plus', onClick: () => userDialog(null)})
        ]),
        rows.length
            ? el('div', {cls: 'table-wrap'}, el('table', {cls: 'data'}, [
                headRow(['Name', 'Type', 'Roles', 'Folder access', 'Status', 'Last login', '']),
                el('tbody', {}, rows)
            ]))
            : el('p', {cls: 'empty', text: 'No users yet. Start with an admin user.'})
    ]);
};

// --- folder groups ---------------------------------------------------------------------------

const groupDialog = existing => {
    const isNew = !existing;
    const paths = new Set(isNew ? [] : existing.paths);
    const list = el('ul', {cls: 'path-list'});
    const renderPaths = () => {
        list.innerHTML = '';
        if (!paths.size) {
            list.appendChild(el('li', {cls: 'muted', text: 'No folders yet — browse below and click "Add this folder".'}));
        }
        Array.from(paths).sort().forEach(p => list.appendChild(el('li', {}, [
            el('code', {text: p}),
            button(null, {cls: 'btn icon danger', iconId: 'trash', title: `Remove ${p}`, onClick: () => {
                paths.delete(p);
                renderPaths();
            }})
        ])));
    };
    renderPaths();
    const addButton = button('Add this folder', {cls: 'btn', iconId: 'plus'});
    const picker = folderPicker('/', current => {
        addButton.querySelector('span:last-child').textContent = `Add ${current}`;
    });
    addButton.addEventListener('click', () => {
        paths.add(picker.current());
        renderPaths();
    });

    const body = el('div', {cls: 'fields'}, [
        field('Name', el('input', {attrs: {name: 'name', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._@\\-]{0,63}',
            value: isNew ? '' : existing.name, autocomplete: 'off'}})),
        field('Description', el('input', {attrs: {name: 'description', maxlength: 200, value: isNew ? '' : existing.description}})),
        el('div', {cls: 'field'}, [el('span', {cls: 'field-label', text: 'Folders'}), list]),
        picker.node,
        addButton
    ]);
    dialog(isNew ? 'Add folder group' : `Edit folder group ${existing.name}`, body, {
        wide: true,
        onSubmit: data => adminRequest('group.save', {group: {
            name: data.get('name'),
            description: data.get('description'),
            paths: Array.from(paths),
            renameFrom: isNew ? null : existing.name
        }}).then(resp => resp.error ? resp : toast('Folder group saved'))
    });
};

const groupsPanel = () => el('section', {cls: 'card'}, [
    el('div', {cls: 'card-head'}, [
        el('h2', {text: 'Folder groups'}),
        button('Add folder group', {cls: 'btn primary', iconId: 'plus', onClick: () => groupDialog(null)})
    ]),
    el('p', {cls: 'help', text: 'A named list of folders. Give a user or role access to a group in their edit dialog.'}),
    state.groups.length
        ? el('div', {cls: 'table-wrap'}, el('table', {cls: 'data'}, [
            headRow(['Group', 'Folders', 'Assigned to', '']),
            el('tbody', {}, state.groups.map(g => el('tr', {}, [
                el('td', {}, [el('strong', {text: g.name}), g.description ? el('div', {cls: 'muted small', text: g.description}) : null]),
                el('td', {}, g.paths.map(p => el('span', {cls: 'chip' + (g.missing.includes(p) ? ' warn' : ''), text: p,
                    attrs: {title: g.missing.includes(p) ? 'folder does not exist' : null}}))),
                el('td', {}, g.members.map(m => el('span', {cls: 'chip level-' + m.level, text: `${m.kind === 'role' ? 'role ' : ''}${m.name}: ${m.level}`}))),
                el('td', {cls: 'actions'}, [
                    button(null, {cls: 'btn icon', iconId: 'edit', title: `Edit ${g.name}`, onClick: () => groupDialog(g)}),
                    button(null, {cls: 'btn icon danger', iconId: 'trash', title: `Delete ${g.name}`,
                        onClick: () => confirmDialog('Delete folder group', `Delete folder group "${g.name}"? Users and roles lose the access it granted.`,
                            () => adminRequest('group.delete', {name: g.name}))})
                ])
            ])))
        ]))
        : el('p', {cls: 'empty', text: 'No folder groups yet.'})
]);

// --- roles ---------------------------------------------------------------------------------

const roleDialog = existing => {
    const isNew = !existing;
    const access = accessEditor(isNew ? [] : existing.access);
    dialog(isNew ? 'Add role' : `Edit role ${existing.name}`, el('div', {cls: 'fields'}, [
        field('Role name', el('input', {attrs: {name: 'name', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._@\\-]{0,63}',
            value: isNew ? '' : existing.name, readonly: !isNew}})),
        field('Description', el('input', {attrs: {name: 'description', maxlength: 200, value: isNew ? '' : existing.description}})),
        access.node
    ]), {
        wide: true,
        onSubmit: data => adminRequest('role.save', {role: {name: data.get('name'), description: data.get('description'), access: access.value()}})
    });
};

const rolesPanel = () => el('section', {cls: 'card'}, [
    el('div', {cls: 'card-head'}, [
        el('h2', {text: 'Roles'}),
        button('Add role', {cls: 'btn primary', iconId: 'plus', onClick: () => roleDialog(null)})
    ]),
    el('div', {cls: 'table-wrap'}, el('table', {cls: 'data'}, [
        headRow(['Role', 'Description', 'Folder access', 'Members', '']),
        el('tbody', {}, state.roles.map(r => el('tr', {}, [
            el('td', {}, [el('strong', {text: r.name}), r.builtin ? el('span', {cls: 'chip', text: 'built-in'}) : null]),
            el('td', {text: r.description || ''}),
            el('td', {}, r.name === 'admin' ? el('span', {cls: 'chip accent', text: 'everything'}) : accessChips(r.access)),
            el('td', {text: String(state.users.filter(u => u.roles.includes(r.name)).length)}),
            el('td', {cls: 'actions'}, [
                r.name === 'admin' ? null : button(null, {cls: 'btn icon', iconId: 'edit', title: `Edit ${r.name}`, onClick: () => roleDialog(r)}),
                r.builtin ? null : button(null, {cls: 'btn icon danger', iconId: 'trash', title: `Delete ${r.name}`,
                    onClick: () => confirmDialog('Delete role', `Delete role "${r.name}"? It's removed from all users and rules.`,
                        () => adminRequest('role.delete', {name: r.name}))})
            ])
        ])))
    ]))
]);

// --- folder rules --------------------------------------------------------------------------

const principalLabel = key => {
    if (key === '*') {
        return 'Everyone (incl. anonymous)';
    }
    const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    return (kind === 'role' ? 'Role: ' : 'User: ') + name;
};

const principalOptions = () => [['*', principalLabel('*')]]
    .concat(state.roles.filter(r => r.name !== 'admin').map(r => ['role:' + r.name, principalLabel('role:' + r.name)]))
    .concat(state.users.map(u => ['user:' + u.name, principalLabel('user:' + u.name)]));

const ruleDialog = existing => {
    // no preselected folder: a rule on "/" affects the whole archive, it has to be chosen on purpose
    const pathInput = el('input', {attrs: {name: 'path', required: true, value: existing ? existing.path : '',
        readonly: !!existing, placeholder: 'pick a folder below'}});
    const grantsBody = el('div', {cls: 'grants'});
    const addGrantRow = (key = '*', level = 'read') => {
        const row = el('div', {cls: 'grant-row'}, [
            select('principal', principalOptions(), key, 'Who'),
            select('level', LEVELS.map(l => [l, `${l} — ${LEVEL_HELP[l]}`]), level, 'Access level'),
            button(null, {cls: 'btn icon danger', iconId: 'trash', title: 'Remove', onClick: () => row.remove()})
        ]);
        grantsBody.appendChild(row);
    };
    if (existing) {
        each(existing.grants, (level, key) => addGrantRow(key, level));
    } else {
        addGrantRow('*', 'read');
    }

    const body = el('div', {cls: 'fields'}, [
        field('Folder', pathInput),
        existing ? null : folderPicker('/', current => {
            // the picker starts at the root; only fill the field once the admin navigates
            if (current !== '/' || pathInput.dataset.touched) {
                pathInput.value = current;
            }
            pathInput.dataset.touched = '1';
        }).node,
        el('div', {cls: 'field'}, [
            el('span', {cls: 'field-label', text: 'Grants'}),
            el('p', {cls: 'help', text: 'The most specific folder rule with a matching grant wins. User grants beat role grants; ' +
                'among roles and "everyone" the highest level applies. Admins always have full access; anon accounts ignore everyone/role grants.'}),
            grantsBody,
            button('Add grant', {cls: 'btn', iconId: 'plus', onClick: () => addGrantRow('*', 'read')})
        ])
    ]);

    dialog(existing ? `Permissions for ${existing.path}` : 'Add folder permission', body, {
        wide: true,
        onSubmit: (data, form) => {
            const grants = {};
            form.querySelectorAll('.grant-row').forEach(row => {
                grants[row.querySelector('[name=principal]').value] = row.querySelector('[name=level]').value;
            });
            const path = String(data.get('path')).trim() || '/';
            // hiding the whole archive from visitors takes a second, deliberate click
            if (path === '/' && grants['*'] === 'none' && !form.dataset.confirmed) {
                form.dataset.confirmed = '1';
                return {error: 'This hides the whole archive from visitors who aren\'t logged in. Click Save again to confirm.'};
            }
            return adminRequest('rule.save', {rule: {path, grants}});
        }
    });
};

const permissionsPanel = () => el('section', {cls: 'card'}, [
    el('div', {cls: 'card-head'}, [
        el('h2', {text: 'Folder rules'}),
        button('Add rule', {cls: 'btn primary', iconId: 'plus', onClick: () => ruleDialog(null)})
    ]),
    el('p', {cls: 'help', text: 'Grants on single folders, e.g. to make one private. Without rules everything is public. ' +
        'Levels: none < list < read < download.'}),
    state.rules.length ? dropinNote() : null,
    state.rules.length
        ? el('div', {cls: 'table-wrap'}, el('table', {cls: 'data'}, [
            headRow(['Folder', 'Grants', '']),
            el('tbody', {}, state.rules.map(rule => el('tr', {}, [
                el('td', {}, [el('code', {text: rule.path}), rule.exists ? null : el('span', {cls: 'chip warn', text: 'missing'})]),
                el('td', {}, Object.keys(rule.grants).map(key => el('span', {cls: 'chip level-' + rule.grants[key],
                    text: `${principalLabel(key)}: ${rule.grants[key]}`}))),
                el('td', {cls: 'actions'}, [
                    button(null, {cls: 'btn icon', iconId: 'edit', title: `Edit ${rule.path}`, onClick: () => ruleDialog(rule)}),
                    button(null, {cls: 'btn icon danger', iconId: 'trash', title: `Delete ${rule.path}`,
                        onClick: () => confirmDialog('Delete rule', `Delete the permission rule for "${rule.path}"?`,
                            () => adminRequest('rule.delete', {path: rule.path}))})
                ])
            ])))
        ]))
        : el('p', {cls: 'empty', text: 'No rules: everything is public.'})
]);

// --- settings (Appearance, Google & SEO, Activity share one settings document) ---------------

const settingsLoading = () => {
    if (!loading.settings) {
        loading.settings = true;
        adminRequest('settings.get');
    }
    return el('section', {cls: 'card'}, el('p', {cls: 'empty', text: 'Loading…'}));
};

const textInput = (name, value, attrs = {}) => el('input', {attrs: Object.assign({name, value: value || '', autocomplete: 'off', spellcheck: 'false'}, attrs)});

// a card with its own form that saves one slice of the settings
const settingsForm = (title, children, toSettings, {submitLabel = 'Save', help} = {}) => {
    const error = el('p', {cls: 'dialog-error', attrs: {role: 'alert', hidden: true}});
    const form = el('form', {cls: 'card settings-form'}, [
        el('h2', {text: title}),
        help ? el('p', {cls: 'help', text: help}) : null,
        ...children,
        error,
        el('div', {cls: 'form-actions'}, button(submitLabel, {cls: 'btn primary', type: 'submit', iconId: 'check'}))
    ]);
    form.addEventListener('submit', ev => {
        ev.preventDefault();
        error.hidden = true;
        adminRequest('settings.save', {settings: toSettings(new win.FormData(form))}).then(resp => {
            if (resp.error) {
                error.textContent = resp.error;
                error.hidden = false;
            } else {
                toast('Saved');
            }
        });
    });
    return form;
};

// --- Google & SEO ----------------------------------------------------------------------------

const googlePanel = () => {
    if (!settings) {
        return settingsLoading();
    }
    const g = settings.google;
    return el('div', {cls: 'stack'}, [
        settingsForm('Google', [
            field('Paste Google code', el('textarea', {attrs: {name: 'snippet', rows: 5, spellcheck: 'false',
                placeholder: '<meta name="google-site-verification" content="…" />\n<!-- Google tag (gtag.js) --> …'}})),
            el('div', {cls: 'field-grid'}, [
                field('Search Console verification', textInput('verification', g.verification, {pattern: '[A-Za-z0-9_\\-]{10,128}'})),
                field('Tag Manager container ID', textInput('tagManagerId', g.tagManagerId, {pattern: 'GTM-[A-Z0-9]{4,12}', placeholder: 'GTM-XXXXXXX'})),
                field('Analytics measurement ID', textInput('measurementId', g.measurementId, {pattern: 'G-[A-Z0-9]{4,16}', placeholder: 'G-XXXXXXXXXX'})),
                field('Measurement Protocol API secret', textInput('apiSecret', '', {type: 'password',
                    placeholder: g.apiSecretSet ? 'set (leave empty to keep)' : 'for server-side tracking'}),
                'GA4 → Admin → Data streams → Measurement Protocol API secrets.')
            ]),
            check('trackDownloads', 'Track downloads', g.trackDownloads, 'file_download events for single files and archives'),
            check('serverSideDownloads', 'Report downloads from the server', g.serverSideDownloads,
                'Counts every download, including direct links and wget. Needs the API secret; turn off GA4\'s own file-download ' +
                'measurement to avoid double counts.'),
            check('sendUserNames', 'Send user names as GA4 user_id', g.sendUserNames,
                'Off: an anonymous, stable id per user (recommended; Google forbids personal data).'),
            g.apiSecretSet ? check('clearSecret', 'Remove the stored API secret', false) : null
        ], data => {
            const google = {
                verification: data.get('verification'),
                tagManagerId: data.get('tagManagerId'),
                measurementId: data.get('measurementId'),
                trackDownloads: data.get('trackDownloads') === 'on',
                serverSideDownloads: data.get('serverSideDownloads') === 'on',
                sendUserNames: data.get('sendUserNames') === 'on'
            };
            if (String(data.get('snippet')).trim()) {
                // pasted code wins over the fields it contains
                google.snippet = data.get('snippet');
                delete google.verification;
                delete google.tagManagerId;
                delete google.measurementId;
            }
            if (data.get('apiSecret')) {
                google.apiSecret = data.get('apiSecret');
            } else if (data.get('clearSecret') === 'on') {
                google.apiSecret = '';
            }
            return {google};
        }, {help: 'Paste the code Google gave you (Search Console tag, Tag Manager or gtag.js snippet). h6ai keeps only the IDs ' +
            'and adds its own safe tags.'}),
        settingsForm('Search engines', [
            check('allowIndexing', 'Allow search engines to index public folders and files', settings.seo.allowIndexing,
                'Folders behind permissions stay invisible to crawlers.'),
            check('sitemap', 'Publish /sitemap.xml (all public folders and files)', settings.seo.sitemap),
            el('p', {cls: 'help'}, [
                'Check ',
                el('a', {text: '/robots.txt', attrs: {href: setup.ROOT_HREF + 'robots.txt', target: '_blank', rel: 'noopener'}}),
                ' and ',
                el('a', {text: '/sitemap.xml', attrs: {href: setup.ROOT_HREF + 'sitemap.xml', target: '_blank', rel: 'noopener'}}),
                ', then submit the sitemap in Search Console.'
            ])
        ], data => ({seo: {allowIndexing: data.get('allowIndexing') === 'on', sitemap: data.get('sitemap') === 'on'}}))
    ]);
};

// --- Appearance ------------------------------------------------------------------------------

const SKINS = require('../core/skins.json');
const CLICK_ACTIONS = [
    ['expand', 'Preview, otherwise show the download panel (recommended)', 'Other files unfold their row with Download, link and curl/wget. Nothing big starts by accident.'],
    ['download-other', 'Preview, otherwise download', 'Files that can\'t be previewed download on a single click.'],
    ['download', 'Always download', 'Every file downloads on a single click. No previews.']
];

const appearancePanel = () => {
    if (!settings) {
        return settingsLoading();
    }
    const current = settings.appearance.theme;
    const previewSkin = key => doc.documentElement.setAttribute('data-skin', key);
    const cards = Object.keys(SKINS).map(key => {
        const info = SKINS[key];
        const isDefault = key === current;
        return el('div', {cls: 'theme-card' + (isDefault ? ' is-default' : ''), attrs: {'data-skin': key}}, [
            el('div', {cls: 'theme-preview', attrs: {'aria-hidden': 'true'}}, [
                el('div', {cls: 'tp-bar'}, [el('span', {cls: 'tp-mark'}), el('span', {cls: 'tp-crumb'})]),
                el('div', {cls: 'tp-row'}, [el('span', {cls: 'tp-icon'}), el('span', {cls: 'tp-name'}), el('span', {cls: 'tp-size'})]),
                el('div', {cls: 'tp-row tp-selected'}, [el('span', {cls: 'tp-icon'}), el('span', {cls: 'tp-name'}), el('span', {cls: 'tp-chip'})]),
                el('div', {cls: 'tp-row'}, [el('span', {cls: 'tp-icon'}), el('span', {cls: 'tp-name short'}), el('span', {cls: 'tp-size'})]),
                el('div', {cls: 'tp-button'})
            ]),
            el('div', {cls: 'theme-meta'}, [
                el('h3', {}, [info.label, isDefault ? el('span', {cls: 'chip accent', text: 'site default'}) : null]),
                el('p', {cls: 'help', text: info.note})
            ]),
            el('div', {cls: 'theme-actions'}, [
                button('Preview', {cls: 'btn small', onClick: () => previewSkin(key), title: `Preview ${info.label} on this page`}),
                isDefault ? null : button('Set as site default', {cls: 'btn small primary', onClick: () =>
                    adminRequest('settings.save', {settings: {appearance: {theme: key}}}).then(resp => {
                        if (!resp.error) {
                            previewSkin(key);
                            toast(`${info.label} is now the site theme`);
                        }
                    })})
            ])
        ]);
    });

    return el('div', {cls: 'stack'}, [
        el('section', {cls: 'card'}, [
            el('h2', {text: 'Theme'}),
            el('p', {cls: 'help', text: 'Visitors see the site default and can pick another theme in their settings. Preview only changes this page.'}),
            el('div', {cls: 'theme-grid'}, cards)
        ]),
        settingsForm('Click on a file name', [
            el('fieldset', {cls: 'radio-list'}, [
                el('legend', {cls: 'visually-hidden', text: 'Click on a file name'}),
                ...CLICK_ACTIONS.map(([value, label, help]) => el('label', {cls: 'radio'}, [
                    el('input', {attrs: {type: 'radio', name: 'clickAction', value, checked: settings.appearance.clickAction === value}}),
                    el('span', {cls: 'radio-text'}, [el('strong', {text: label}), el('small', {text: help})])
                ]))
            ])
        ], data => ({appearance: {clickAction: data.get('clickAction')}})),
        settingsForm('Site name', [
            field('Site name', textInput('siteName', settings.siteName, {maxlength: 60, required: true}),
                'Shown next to the h6ai logo and in page titles.')
        ], data => ({siteName: data.get('siteName')}))
    ]);
};

// --- activity log ----------------------------------------------------------------------------

const KIND_LABELS = {file: 'download', archive: 'archive', login: 'login', 'login-failed': 'failed login'};

const loadActivity = () => adminRequest('activity.list', {
    limit: 300,
    user: activityFilter.user === '' ? null : activityFilter.user === '(guest)' ? '' : activityFilter.user,
    kind: activityFilter.kind || null,
    path: activityFilter.path || null
});

const activityPanel = () => {
    if (!activity) {
        if (!loading.activity) {
            loading.activity = true;
            loadActivity();
        }
        return el('section', {cls: 'card'}, el('p', {cls: 'empty', text: 'Loading…'}));
    }
    const counts = activity.stats.counts || {};
    const number = value => Number(value || 0).toLocaleString();
    const stat = (label, value) => el('div', {}, [el('dt', {text: label}), el('dd', {text: value})]);
    const top = (title, items) => el('div', {cls: 'top-list'}, [
        el('h3', {text: title}),
        items.length ? el('ol', {}, items.map(i => el('li', {}, [el('span', {cls: 'top-name', text: i.name}), el('span', {cls: 'top-count', text: number(i.count)})])))
            : el('p', {cls: 'muted', text: '—'})
    ]);

    const userSelect = select('user', [['', 'All users'], ['(guest)', 'Guests']].concat(state.users.map(u => [u.name, u.name])), activityFilter.user, 'User');
    const kindSelect = select('kind', [['', 'All events'], ['file', 'Downloads'], ['archive', 'Archives'], ['login', 'Logins'], ['login-failed', 'Failed logins']], activityFilter.kind, 'Event type');
    const pathInput = el('input', {attrs: {name: 'path', value: activityFilter.path, placeholder: 'path contains…', type: 'search', 'aria-label': 'Path contains'}});
    const filters = el('form', {cls: 'filters', attrs: {role: 'search', 'aria-label': 'Filter activity'}}, [userSelect, kindSelect, pathInput]);
    const apply = () => {
        activityFilter = {user: userSelect.value, kind: kindSelect.value, path: pathInput.value.trim()};
        loadActivity();
    };
    // selects apply immediately, the path filter on Enter
    userSelect.addEventListener('change', apply);
    kindSelect.addEventListener('change', apply);
    filters.addEventListener('submit', ev => {
        ev.preventDefault();
        apply();
    });

    return el('div', {}, [
        el('section', {cls: 'card'}, [
            el('div', {cls: 'card-head'}, [el('h2', {text: 'Activity'}), button('Refresh', {cls: 'btn', iconId: 'activity', onClick: loadActivity})]),
            el('dl', {cls: 'summary'}, [
                stat('downloads started', number(counts.file)),
                stat('data requested', format.formatSize(activity.stats.bytes || 0) || '0 B'),
                stat('archives', number(counts.archive)),
                stat('logins', number(counts.login)),
                stat('failed logins', number(counts['login-failed']))
            ]),
            el('div', {cls: 'tops'}, [top('Top files', activity.stats.topFiles), top('Top users', activity.stats.topUsers)]),
            el('p', {cls: 'help', text: `From the last ${Number(activity.stats.scanned).toLocaleString()} log entries matching the filter.`})
        ]),
        el('section', {cls: 'card'}, [
            filters,
            activity.entries.length
                ? el('div', {cls: 'table-wrap'}, el('table', {cls: 'data compact'}, [
                    headRow(['Time', 'Event', 'User', 'IP', 'Path', 'Size']),
                    el('tbody', {}, activity.entries.map(e => el('tr', {}, [
                        el('td', {cls: 'nowrap', text: formatTime(e.time)}),
                        el('td', {}, el('span', {cls: 'chip kind-' + e.kind, text: KIND_LABELS[e.kind] || e.kind})),
                        el('td', {text: e.user || (e.kind === 'login-failed' ? `(${e.attempted || '?'})` : 'guest')}),
                        el('td', {cls: 'mono', text: e.ip}),
                        el('td', {}, e.path ? el('code', {text: e.path}) : null),
                        el('td', {cls: 'nowrap', text: e.size ? format.formatSize(e.size) : ''})
                    ])))
                ]))
                : el('p', {cls: 'empty', text: 'No matching entries.'})
        ]),
        settings ? settingsForm('Activity log settings', [
            check('logEnabled', 'Record downloads, archive downloads and logins', settings.activityLog.enabled),
            field('Keep entries for (days)', textInput('retentionDays', String(settings.activityLog.retentionDays), {type: 'number', min: 1, max: 3650}))
        ], data => ({activityLog: {enabled: data.get('logEnabled') === 'on', retentionDays: Number(data.get('retentionDays'))}})) : settingsLoading()
    ]);
};

// --- system checks -------------------------------------------------------------------------

const checks = () => [
    ['h6ai version', 'Release builds have a plain x.y.z version', (/^\d+\.\d+\.\d+$/).test(setup.VERSION), setup.VERSION],
    ['Index file', `Add ${setup.INDEX_HREF} to your nginx index directive`, !!setup.INDEX_HREF, setup.INDEX_HREF],
    ['Options parsable', 'options.json and options.local.json are valid', setup.HAS_VALID_OPTIONS !== false],
    ['Server software', 'nginx (other servers may work)', setup.HAS_SERVER, `${setup.SERVER_NAME} ${setup.SERVER_VERSION}`],
    ['PHP version', `PHP ≥ ${setup.MIN_PHP_VERSION}`, true, setup.PHP_VERSION],
    ['CVE-2026-109618', 'PHP has the fix for RCE via out-of-memory corruption (8.2.35 / 8.3.36 / 8.4.27 / 8.5.12)',
        setup.PHP_CVE_2026_109618_FIXED, setup.PHP_CVE_2026_109618_FIX === 'backport' ? 'patched (distribution backport)'
            : setup.PHP_CVE_2026_109618_FIXED ? 'patched' : 'UPDATE PHP'],
    ['PHP arch', '64-bit required for files > 2 GB', setup.PHP_ARCH === '64-bit', setup.PHP_ARCH],
    ['Public cache', 'Writable, needed for thumbnails', setup.HAS_WRITABLE_CACHE_PUB],
    ['Private cache', 'Writable, needed for caching and login rate limits', setup.HAS_WRITABLE_CACHE_PRV],
    ['Data directory', 'Writable, needed for users, permissions, settings and the activity log', setup.HAS_WRITABLE_DATA],
    ['Image thumbs', 'PHP GD with JPEG support', setup.HAS_PHP_JPEG],
    ['WebP / AVIF', 'PHP GD WebP and AVIF support', setup.HAS_PHP_WEBP && setup.HAS_PHP_AVIF,
        `${setup.HAS_PHP_WEBP ? 'webp' : '-'} / ${setup.HAS_PHP_AVIF ? 'avif' : '-'}`],
    ['EXIF', 'PHP EXIF extension (thumbnail orientation)', setup.HAS_PHP_EXIF],
    ['Movie thumbs', 'ffmpeg available', setup.HAS_CMD_FFMPEG || setup.HAS_CMD_AVCONV],
    ['PDF thumbs', 'Ghostscript, ImageMagick or GraphicsMagick available', setup.HAS_CMD_GS || setup.HAS_CMD_MAGICK || setup.HAS_CMD_CONVERT || setup.HAS_CMD_GM],
    ['Shell tar', 'tar available', setup.HAS_CMD_TAR],
    ['Shell zip', 'zip available', setup.HAS_CMD_ZIP],
    ['Shell du', 'du available', setup.HAS_CMD_DU],
    ['timeout', 'Bounds thumbnail subprocess run time', setup.HAS_CMD_TIMEOUT]
];

const yesNo = value => value ? 'yes' : 'no';

const proxyPanel = () => {
    if (!settings) {
        return settingsLoading();
    }
    const proxy = settings.proxy || {publicUrl: '', trusted: []};
    const trustedInput = el('textarea', {attrs: {name: 'trusted', rows: 3, spellcheck: 'false', autocomplete: 'off',
        placeholder: '10.0.0.5\n172.16.0.0/12'}, text: (proxy.trusted || []).join('\n')});
    const r = requestInfo;
    const rows = r ? [
        ['Came from', r.remoteAddr + (r.fromTrustedProxy ? ' (trusted proxy)' : '')],
        ['Visitor address', r.clientIp],
        ['X-Forwarded-For', r.forwardedFor || '—'],
        ['X-Forwarded-Proto / Host', `${r.forwardedProto || '—'} / ${r.forwardedHost || '—'}`],
        ['HTTPS', yesNo(r.https)],
        ['Links use', r.publicOrigin]
    ] : [];
    // a proxy forwarded this request, but isn't trusted yet: offer its address
    const suggest = r && r.forwardedFor && !r.fromTrustedProxy
        ? button(`Trust ${r.remoteAddr}`, {cls: 'btn small', onClick: () => {
            trustedInput.value = (trustedInput.value.trim() + '\n' + r.remoteAddr).trim();
        }})
        : null;

    return settingsForm('Public address and reverse proxy', [
        field('Public address', textInput('publicUrl', proxy.publicUrl, {placeholder: 'https://files.example.com', inputmode: 'url'}),
            'The address visitors use. Download links, curl and wget lines, QR codes, the sitemap and server-side Analytics use it, ' +
            'and logins arriving through the proxy are accepted for it. Empty: the address of each request.'),
        field('Trusted proxies', trustedInput,
            'One IP address or CIDR range per line. Only requests from these addresses may set X-Forwarded-For, -Proto and -Host: ' +
            'h6ai then logs, rate-limits and reports the visitor\'s real address. Never list addresses visitors can reach h6ai from directly.'),
        r ? el('div', {cls: 'field'}, [
            el('span', {cls: 'field-label', text: 'This request, as h6ai sees it'}),
            el('dl', {cls: 'request-info'}, rows.flatMap(([key, value]) => [el('dt', {text: key}), el('dd', {}, el('code', {text: value}))])),
            suggest
        ]) : null
    ], data => ({proxy: {publicUrl: data.get('publicUrl'), trusted: data.get('trusted')}}), {
        help: 'Only needed behind a reverse proxy or load balancer (nginx, Caddy, Traefik, a CDN).'
    });
};

// passed: true, false, null (still checking) or 'advice' (worth doing, nothing broken)
const checkRow = (label, info, passed, result) => el('li', {cls: passed === null || passed === 'advice' ? 'pending' : passed ? 'passed' : 'failed'}, [
    el('span', {cls: 'check-state', html: resource.ui(passed === null || passed === 'advice' ? 'info' : passed ? 'check' : 'close')}),
    el('span', {cls: 'check-label', text: label}),
    el('span', {cls: 'check-info', text: info}),
    el('span', {cls: 'check-result', text: passed === null ? 'checking' : result})
]);

// Drop-in installs (no h6ai nginx snippet): h6ai serves the files folder itself. Most checks run
// in the browser (runChecks), so they see what nginx really does.
const dropinPanel = () => !setup.IS_DROPIN ? null : el('section', {cls: 'card'}, [
    el('h2', {text: 'Drop-in install'}),
    el('p', {cls: 'help', text: 'h6ai runs from your web root and hands out the files folder itself: every file passes its ' +
        'permission check, download log and HTML sandbox. These checks test what your server actually does.'}),
    el('ul', {cls: 'checks'}, [
        checkRow('Files folder', 'Outside the web root, so only h6ai hands out its files', !setup.ROOT_IN_WEBROOT,
            setup.ROOT_PATH + (setup.ROOT_IN_WEBROOT ? ' (inside the web root)' : '')),
        checkRow('Routing', `nginx hands unknown paths to h6ai (${ERROR_PAGE_LINE})`, dropin.routed, dropin.routed ? 'yes' : 'no'),
        checkRow('Private data', '_h6ai/private/ can\'t be read over the web', dropin.exposed === null ? null : !dropin.exposed,
            dropin.exposed ? 'EXPOSED' : 'protected'),
        checkRow('Private cache', 'Not listed by nginx (holds the secret file links)', dropin.listed === null ? null : !dropin.listed,
            dropin.listed ? 'LISTED' : 'not listed'),
        checkRow('Fast downloads', 'nginx sends the bytes (X-Accel-Redirect); otherwise PHP does, one PHP worker per download',
            dropin.fast, dropin.fast ? 'nginx' : 'PHP'),
        checkRow('Request bodies', 'PHP leaves them to h6ai (_h6ai/public/.user.ini), the CVE-2026-109618 trigger stays off',
            setup.HAS_POST_PARSING_OFF === true, setup.HAS_POST_PARSING_OFF ? 'off' : 'PHP parses them'),
        checkRow('Server version', 'nginx\'s own header; "server_tokens off;" in nginx.conf hides the version (optional)',
            dropin.server === null ? null : (/\d/).test(dropin.server) ? 'advice' : true, dropin.server || 'hidden')
    ]),
    el('p', {cls: 'help', text: 'The server block needs this line, next to your usual PHP location:'}),
    el('pre', {text: ERROR_PAGE_LINE}),
    el('p', {cls: 'help', text: 'The files folder is "filesFolder" in _h6ai/private/conf/options.local.php. ' +
        'Step by step: docs/install/dropin.md.'})
]);

const checksPanel = () => el('section', {cls: 'card'}, [
    el('div', {cls: 'card-head'}, [el('h2', {text: 'System'}),
        button('Re-check', {cls: 'btn', title: 'Re-detect installed tools', onClick: reload})]),
    el('ul', {cls: 'checks'}, checks().map(([label, info, passed, result]) => el('li', {cls: passed ? 'passed' : 'failed'}, [
        el('span', {cls: 'check-state', html: resource.ui(passed ? 'check' : 'close')}),
        el('span', {cls: 'check-label', text: label}),
        el('span', {cls: 'check-info', text: info}),
        el('span', {cls: 'check-result', text: result !== undefined && result !== null ? String(result) : passed ? 'yes' : 'no'})
    ])))
]);

const systemPanel = () => el('div', {cls: 'stack'}, [dropinPanel(), proxyPanel(), checksPanel()]);

// --- access ---------------------------------------------------------------------------------

const REASONS = {
    'admin': 'admins always see everything',
    'no rules': 'there are no folder rules or folder groups yet, so everything is public',
    'default': 'no rule covers this folder, so the default applies',
    'anon default': 'download-only account: none of its folder groups covers this folder'
};

const accessChecker = () => {
    const principal = select('principal', [['*', 'Everyone (not logged in)']].concat(state.users.map(u => ['user:' + u.name, u.name + (u.type === 'anon' ? ' (anon)' : '')])),
        accessResult && accessResult.principal ? accessResult.principal : '*', 'Check as');
    const path = el('input', {attrs: {name: 'path', value: accessResult ? accessResult.path : '/', required: true, spellcheck: 'false',
        'aria-label': 'Folder path'}});
    const form = el('form', {cls: 'checker'}, [
        el('span', {cls: 'checker-label', text: 'Who can see'}),
        path,
        el('span', {cls: 'checker-label', text: 'as'}),
        principal,
        button('Check', {cls: 'btn primary', type: 'submit', iconId: 'search'})
    ]);
    form.addEventListener('submit', ev => {
        ev.preventDefault();
        const data = new win.FormData(form);
        adminRequest('access.check', {principal: data.get('principal'), path: data.get('path')}).then(resp => {
            if (resp.access) {
                accessResult.principal = data.get('principal');
                render(); // eslint-disable-line no-use-before-define
            } else if (resp.error) {
                toast(resp.error, 'error');
            }
        });
    });

    let result = null;
    if (accessResult) {
        const r = accessResult;
        const why = r.reason === 'rule' ? `decided by the permission on ${r.rule}` : REASONS[r.reason] || r.reason;
        result = el('p', {cls: 'checker-result', attrs: {role: 'status'}}, [
            el('strong', {text: r.who}),
            ' → ',
            el('span', {cls: 'chip level-' + r.level, text: r.level}),
            ` on ${r.path}: ${why}.`,
            r.level === 'none' && r.reachable ? ' They can still navigate through it to folders shared below.' : '',
            r.exists ? '' : ' (This folder doesn\'t exist.)'
        ]);
    }
    return el('section', {cls: 'card'}, [
        el('h2', {text: 'Check access'}),
        form,
        result || el('p', {cls: 'help', text: 'See what someone can do in a folder, and which rule decides it.'})
    ]);
};

// --- visitors: anonymous mode and excluded folders ------------------------------------------

// sub-view of the Access tab (see ACCESS_VIEWS)
let accessView = store.get('admin/access') || 'visitors';

const VISITOR_MODES = [
    ['0', 'Public, with sign-in',
        'Visitors browse everything that isn\'t restricted. People with an account sign in from the listing to see the folders shared with them.'],
    ['1', 'Anonymous, no sign-in',
        'Everyone browses and downloads everything except the excluded folders. The listing has no sign-in: only admins sign in, on this page. Other accounts can\'t sign in while this is on.']
];

const toFolderPath = path => {
    const segments = String(path).split('/').filter(seg => seg && seg !== '.');
    return segments.length ? '/' + segments.join('/') + '/' : '/';
};

// An excluded folder is a folder rule that grants "everyone" nothing.
const excludedRules = () => state.rules.filter(rule => rule.grants['*'] === 'none');

const excludeDialog = () => {
    const pathInput = el('input', {attrs: {name: 'path', required: true, placeholder: 'pick a folder below'}});
    const picker = folderPicker('/', current => {
        if (current !== '/' || pathInput.dataset.touched) {
            pathInput.value = current;
        }
        pathInput.dataset.touched = '1';
    });
    const body = el('div', {cls: 'fields'}, [
        field('Folder', pathInput, 'The folder and everything in it disappear for visitors.'),
        picker.node
    ]);
    dialog('Exclude a folder', body, {
        submitLabel: 'Exclude',
        wide: true,
        onSubmit: (data, form) => {
            const path = toFolderPath(data.get('path'));
            if (path === '/' && !form.dataset.confirmed) {
                form.dataset.confirmed = '1';
                return {error: 'This hides the whole archive from visitors. Click Exclude again to confirm.'};
            }
            // keep the folder's other grants (users, roles) and add "everyone: none"
            const existing = state.rules.find(rule => rule.path === path);
            const grants = Object.assign({}, existing ? existing.grants : {}, {'*': 'none'});
            return adminRequest('rule.save', {rule: {path, grants}});
        }
    });
};

const includeAgain = rule => {
    const grants = Object.assign({}, rule.grants);
    delete grants['*'];
    // a rule left without grants is removed
    return adminRequest('rule.save', {rule: {path: rule.path, grants}});
};

const visitorsPanel = () => {
    if (!settings) {
        return settingsLoading();
    }
    const anonymous = settings.visitors && settings.visitors.anonymous === true;
    const excluded = excludedRules();
    const limiting = state.rules.filter(rule => rule.grants['*'] && rule.grants['*'] !== 'none' && rule.grants['*'] !== 'download');
    const showRules = () => {
        accessView = 'rules';
        store.put('admin/access', 'rules');
        render(); // eslint-disable-line no-use-before-define
    };

    return el('div', {cls: 'stack'}, [
        settingsForm('Visitors', [
            el('fieldset', {cls: 'radio-list'}, [
                el('legend', {cls: 'visually-hidden', text: 'How visitors use the site'}),
                ...VISITOR_MODES.map(([value, label, help]) => el('label', {cls: 'radio'}, [
                    el('input', {attrs: {type: 'radio', name: 'anonymous', value, checked: (value === '1') === anonymous}}),
                    el('span', {cls: 'radio-text'}, [el('strong', {text: label}), el('small', {text: help})])
                ]))
            ])
        ], data => ({visitors: {anonymous: data.get('anonymous') === '1'}})),
        el('section', {cls: 'card'}, [
            el('div', {cls: 'card-head'}, [
                el('h2', {text: 'Excluded folders'}),
                button('Exclude a folder', {cls: 'btn primary', iconId: 'plus', onClick: excludeDialog})
            ]),
            el('p', {cls: 'help', text: 'Hidden from visitors who aren\'t signed in, with everything inside: not listed, not searchable, ' +
                'not downloadable, not in the sitemap. Direct links answer 403. Admins still see them.'}),
            excluded.length ? dropinNote() : null,
            excluded.length
                ? el('div', {cls: 'table-wrap'}, el('table', {cls: 'data'}, [
                    headRow(['Folder', '']),
                    el('tbody', {}, excluded.map(rule => el('tr', {}, [
                        el('td', {}, [el('span', {cls: 'path-cell'}, [icon('lock'), el('code', {text: rule.path})]),
                            rule.exists ? null : el('span', {cls: 'chip warn', text: 'missing'})]),
                        el('td', {cls: 'actions'}, button('Show again', {cls: 'btn small', title: `Show ${rule.path} to visitors again`,
                            onClick: () => includeAgain(rule)}))
                    ])))
                ]))
                : el('p', {cls: 'empty', text: 'Nothing is excluded: visitors see every folder.'}),
            limiting.length
                ? el('p', {cls: 'help'}, [
                    `${limiting.length} other folder ${limiting.length === 1 ? 'rule limits' : 'rules limit'} what visitors can do (list or read only). `,
                    button('Show folder rules', {cls: 'btn link', onClick: showRules})
                ])
                : null
        ])
    ]);
};

const ACCESS_VIEWS = [
    ['visitors', 'Visitors', visitorsPanel],
    ['users', 'Users', usersPanel],
    ['groups', 'Folder groups', groupsPanel],
    ['roles', 'Roles', rolesPanel],
    ['rules', 'Folder rules', permissionsPanel]
];

const accessPanel = () => {
    const nav = el('div', {cls: 'segmented subnav', attrs: {role: 'tablist', 'aria-label': 'Access'}}, ACCESS_VIEWS.map(([id, label]) => el('button', {
        cls: 'button' + (id === accessView ? ' active' : ''),
        text: label,
        attrs: {type: 'button', role: 'tab', 'aria-selected': id === accessView ? 'true' : 'false', tabindex: id === accessView ? '0' : '-1', 'data-view': id},
        on: {click: () => {
            accessView = id;
            store.put('admin/access', id);
            render(); // eslint-disable-line no-use-before-define
        }}
    })));
    const view = (ACCESS_VIEWS.find(([id]) => id === accessView) || ACCESS_VIEWS[0])[2];
    return el('div', {cls: 'stack'}, [accessChecker(), arrowTabs(nav), view()]);
};

// --- layout --------------------------------------------------------------------------------

const TABS = [
    ['access', 'Access', 'users', accessPanel],
    ['appearance', 'Appearance', 'view-grid', appearancePanel],
    ['google', 'Google & SEO', 'search', googlePanel],
    ['activity', 'Activity', 'activity', activityPanel],
    ['system', 'System', 'shield', systemPanel]
];
// tab ids before the access tabs were merged
const LEGACY_TABS = {users: 'users', groups: 'groups', permissions: 'rules', roles: 'roles'};
let activeTab = store.get('admin/tab') || 'access';
if (LEGACY_TABS[activeTab]) {
    accessView = LEGACY_TABS[activeTab];
    activeTab = 'access';
}

const header = () => {
    const right = [];
    if (user) {
        right.push(el('span', {cls: 'whoami'}, [icon('user'), el('span', {text: user.name})]));
        right.push(button('Log out', {cls: 'btn', iconId: 'log-out', onClick: () => server.request({action: 'logout', csrf: setup.CSRF}).then(reload)}));
    }
    return el('div', {cls: 'admin-header'}, [
        el('a', {cls: 'brand', attrs: {href: setup.ROOT_HREF || '/', title: 'Back to files'}}, [
            el('img', {attrs: {src: setup.PUBLIC_HREF + 'images/brand/logo-mark.svg', alt: '', width: 32, height: 32}}),
            el('span', {cls: 'brand-name', text: site.name || 'h6ai'})
        ]),
        el('h1', {text: 'Admin'}),
        el('div', {cls: 'admin-header-right'}, right)
    ]);
};

const render = () => {
    const refocus = focusedTab();
    const root = doc.getElementById('content');
    root.innerHTML = '';
    root.className = 'admin';
    root.setAttribute('role', 'main');
    root.appendChild(header());

    const banners = [privateBanner(), plainLocalBanner(), routingBanner()].filter(Boolean);
    if (!user) {
        banners.forEach(banner => root.appendChild(banner));
        root.appendChild(loginCard());
        return;
    }

    if (!user.isAdmin) {
        root.appendChild(el('section', {cls: 'card narrow'}, [
            el('h2', {text: `Logged in as ${user.name}`}),
            el('p', {text: 'You don\'t have admin rights.'}),
            el('a', {cls: 'btn', text: 'Back to files', attrs: {href: setup.ROOT_HREF || '/'}})
        ]));
        return;
    }

    if (user.isAdmin) {
        banners.forEach(banner => root.appendChild(banner));
    }
    if (user.bootstrap) {
        root.appendChild(el('div', {cls: 'banner warn'}, [icon('key'), el('span', {text:
            'You\'re using the setup password. Create an admin user: the setup password then stops working and you log in as that user.'})]));
    }
    if (!state.writable) {
        root.appendChild(el('div', {cls: 'banner error'}, [icon('info'), el('span', {text:
            'The data directory (_h6ai/private/data) is not writable for PHP, users and permissions can\'t be saved.'})]));
    }
    if (setup.PHP_CVE_2026_109618_FIXED === false) {
        root.appendChild(el('div', {cls: 'banner error'}, [icon('info'), el('span', {text:
            `PHP ${setup.PHP_VERSION} is affected by CVE-2026-109618 (remote code execution). Update PHP to 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12 or later.`})]));
    }

    const tabs = el('nav', {cls: 'tabs', attrs: {role: 'tablist'}}, TABS.map(([id, label, iconId]) => el('button', {
        cls: 'tab' + (id === activeTab ? ' active' : ''),
        attrs: {type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'tab-panel', 'aria-selected': id === activeTab ? 'true' : 'false', tabindex: id === activeTab ? '0' : '-1', 'data-tab': id},
        on: {click: () => {
            activeTab = id;
            store.put('admin/tab', id);
            render();
        }}
    }, [icon(iconId), el('span', {text: label})])));
    root.appendChild(arrowTabs(tabs));

    const panel = (TABS.find(([id]) => id === activeTab) || TABS[0])[3];
    root.appendChild(el('div', {cls: 'tab-panel', attrs: {role: 'tabpanel', id: 'tab-panel', 'aria-labelledby': 'tab-' + activeTab}}, panel()));
    const again = refocus && doc.querySelector(refocus);
    if (again) {
        again.focus();
    }
};

const init = () => {
    doc.title = `${site.name || 'h6ai'} admin`;
    runChecks();
    if (user && user.isAdmin) {
        adminRequest('list').then(resp => {
            if (resp.error) {
                render();
            }
        });
    } else {
        render();
    }
};


init();

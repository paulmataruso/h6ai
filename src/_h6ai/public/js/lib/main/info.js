// Admin page (/_h6ai/public/): login, users, folder groups, folder rules, roles, Google & SEO,
// activity log and system checks.
const {dom, each} = require('../util');
const config = require('../config');
const server = require('../server');
const resource = require('../core/resource');
const store = require('../core/store');
const format = require('../core/format');

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

// --- login ---------------------------------------------------------------------------------

const loginCard = () => {
    if (!auth.loginAvailable) {
        return el('section', {cls: 'card'}, [
            el('h2', {text: 'Admin login is not set up'}),
            el('p', {text: 'Set a bootstrap password to log in the first time, then create real admin users here:'}),
            el('pre', {text: 'php _h6ai/private/bin/h6ai-passhash.php\n# put the hash into _h6ai/private/conf/options.local.json:\n{"passhash": "<hash>"}\n# or set the H6AI_PASSHASH environment variable'})
        ]);
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
        setup.PHP_CVE_2026_109618_FIXED, setup.PHP_CVE_2026_109618_FIXED ? 'patched' : 'UPDATE PHP'],
    ['PHP arch', '64-bit required for files > 2 GB', setup.PHP_ARCH === '64-bit', setup.PHP_ARCH],
    ['Public cache', 'Writable, needed for thumbnails', setup.HAS_WRITABLE_CACHE_PUB],
    ['Private cache', 'Writable, needed for caching and login rate limits', setup.HAS_WRITABLE_CACHE_PRV],
    ['Data directory', 'Writable, needed for users, permissions, settings and the activity log', setup.HAS_WRITABLE_DATA],
    ['Image thumbs', 'PHP GD with JPEG support', setup.HAS_PHP_JPEG],
    ['WebP / AVIF', 'PHP GD WebP and AVIF support', setup.HAS_PHP_WEBP && setup.HAS_PHP_AVIF,
        `${setup.HAS_PHP_WEBP ? 'webp' : '-'} / ${setup.HAS_PHP_AVIF ? 'avif' : '-'}`],
    ['EXIF', 'PHP EXIF extension (thumbnail orientation)', setup.HAS_PHP_EXIF],
    ['Movie thumbs', 'ffmpeg available', setup.HAS_CMD_FFMPEG || setup.HAS_CMD_AVCONV],
    ['PDF thumbs', 'ImageMagick (magick/convert) or GraphicsMagick available', setup.HAS_CMD_MAGICK || setup.HAS_CMD_CONVERT || setup.HAS_CMD_GM],
    ['Shell tar', 'tar available', setup.HAS_CMD_TAR],
    ['Shell zip', 'zip available', setup.HAS_CMD_ZIP],
    ['Shell du', 'du available', setup.HAS_CMD_DU],
    ['timeout', 'Bounds thumbnail subprocess run time', setup.HAS_CMD_TIMEOUT]
];

const systemPanel = () => el('section', {cls: 'card'}, [
    el('div', {cls: 'card-head'}, [el('h2', {text: 'System'}),
        button('Re-check', {cls: 'btn', title: 'Re-detect installed tools', onClick: reload})]),
    el('ul', {cls: 'checks'}, checks().map(([label, info, passed, result]) => el('li', {cls: passed ? 'passed' : 'failed'}, [
        el('span', {cls: 'check-state', html: resource.ui(passed ? 'check' : 'close')}),
        el('span', {cls: 'check-label', text: label}),
        el('span', {cls: 'check-info', text: info}),
        el('span', {cls: 'check-result', text: result !== undefined && result !== null ? String(result) : passed ? 'yes' : 'no'})
    ])))
]);

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

const ACCESS_VIEWS = [
    ['users', 'Users', usersPanel],
    ['groups', 'Folder groups', groupsPanel],
    ['roles', 'Roles', rolesPanel],
    ['rules', 'Folder rules', permissionsPanel]
];
let accessView = store.get('admin/access') || 'users';

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

    if (!user) {
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

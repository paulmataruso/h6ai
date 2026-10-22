const {each, toArray, dom, cmp, naturalCmp} = require('../util');
const event = require('../core/event');
const resource = require('../core/resource');
const allsettings = require('../core/settings');
const store = require('../core/store');

const settings = Object.assign({
    enabled: false,
    column: 0,
    reverse: false,
    ignorecase: true,
    natural: false,
    folders: 0
}, allsettings.sort);
const storekey = 'ext/sort';
const tpl = `<span class="sort">${resource.ui('sort')}</span>`;

const getTypeOrder = item => item.isFolder() ? settings.folders : 1;
const columnProps = {0: 'label', 1: 'time', 2: 'size'};
const columnClasses = {0: 'label', 1: 'date', 2: 'size'};


const cmpFn = (prop, reverse, ignorecase, natural) => {
    return (el1, el2) => {
        const item1 = el1._item;
        const item2 = el2._item;

        let res = getTypeOrder(item1) - getTypeOrder(item2);
        if (res !== 0) {
            return res;
        }

        let val1 = item1[prop];
        let val2 = item2[prop];

        if (isNaN(val1) || isNaN(val2)) {
            val1 = String(val1);
            val2 = String(val2);

            if (ignorecase) {
                val1 = val1.toLowerCase();
                val2 = val2.toLowerCase();
            }
        }

        res = natural ? naturalCmp(val1, val2) : cmp(val1, val2);
        return reverse ? -res : res;
    };
};

const sortItems = (column, reverse) => {
    const $headers = dom('#items li.header button');
    const $header = dom('#items li.header button.' + columnClasses[column]);
    const fn = cmpFn(columnProps[column], reverse, settings.ignorecase, settings.natural);

    store.put(storekey, {column: Number(column), reverse});

    $headers.rmCls('ascending').rmCls('descending').find('.sort-state').text('');
    $header.addCls(reverse ? 'descending' : 'ascending').find('.sort-state').text(reverse ? ', sorted descending' : ', sorted ascending');

    event.pub('view.sorted');
    dom(toArray(dom('#items .item:not(.folder-parent)')).sort(fn)).appTo('#items');
};

const onContentChanged = () => {
    const order = store.get(storekey) || {};
    const column = order.column !== undefined ? Number(order.column) : settings.column;
    const reverse = order.reverse !== undefined ? !!order.reverse : settings.reverse;

    sortItems(column, reverse);
};

const addToggles = () => {
    const $header = dom('#items li.header');

    each(columnClasses, (cls, idx) => {
        const pos = idx === '0' ? 'app' : 'pre';
        $header
            .find('button.' + cls)[pos](tpl)
            .on('click', ev => {
                sortItems(idx, dom(ev.currentTarget).hasCls('ascending'));
                ev.preventDefault();
            });
    });
};

const init = () => {
    if (!settings.enabled) {
        return;
    }

    addToggles();
    event.sub('view.changed', onContentChanged);
};


init();

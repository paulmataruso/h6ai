// Small wrapper around localStorage. Storage can be unavailable (privacy modes, blocked site
// data); everything keeps working, settings just aren't persisted then.
const storekey = '_h6ai';
let memory = {};

const getStorage = () => {
    try {
        return global.window.localStorage;
    } catch (e) {
        return null;
    }
};

const load = () => {
    try {
        const storage = getStorage();
        const raw = storage && storage.getItem(storekey);
        return raw ? JSON.parse(raw) : Object.assign({}, memory);
    } catch (e) {
        return Object.assign({}, memory);
    }
};

const save = obj => {
    memory = obj;
    try {
        const storage = getStorage();
        if (storage) {
            storage.setItem(storekey, JSON.stringify(obj));
        }
    } catch (e) {/* skip */}
};

const put = (key, value) => {
    const obj = load();
    obj[key] = value;
    save(obj);
};

const get = key => load()[key];

module.exports = {
    put,
    get
};

// Copies text. navigator.clipboard only exists in secure contexts (HTTPS / localhost); h6ai is
// often served over plain HTTP on a LAN, so fall back to a temporary textarea + execCommand.
const win = global.window;

const legacyCopy = text => {
    const doc = win.document;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    doc.body.appendChild(area);
    area.select();
    let ok = false;
    try {
        ok = doc.execCommand('copy');
    } catch (e) {
        ok = false;
    }
    area.remove();
    return ok;
};

const copyText = text => {
    if (win.navigator.clipboard && win.isSecureContext) {
        return win.navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
};

module.exports = {copyText};

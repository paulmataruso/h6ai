// "Panels" block in the settings drawer, shared by the folder tree and info panel switches.
const {dom} = require('../util');
const sidebar = require('./sidebar');

const $block = dom('<div id="panels-settings" class="block"><h3>Panels</h3><div class="switches"></div></div>');
$block.appTo(sidebar.$el);

module.exports = {
    $el: $block.find('.switches')
};

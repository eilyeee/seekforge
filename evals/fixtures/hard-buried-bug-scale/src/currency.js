"use strict";
// Formatting helper (not on the total path). Present for realism.
function format(cents, symbol = "$") { return symbol + (cents / 100).toFixed(2); }
module.exports = { format };

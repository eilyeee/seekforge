"use strict";
const { priceOf } = require("./catalog");
function lineSubtotal(item) { return priceOf(item.sku) * item.qty; }
function subtotal(items) { return items.reduce((acc, it) => acc + lineSubtotal(it), 0); }
module.exports = { lineSubtotal, subtotal };

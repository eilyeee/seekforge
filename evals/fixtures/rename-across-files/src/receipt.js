"use strict";

const { fmtPrice } = require("./format.js");

/** One "name: $X.YZ" line per item. */
function receiptLines(items) {
  return items.map((item) => `${item.name}: ${fmtPrice(item.priceCents)}`);
}

module.exports = { receiptLines };

"use strict";

const { fmtPrice } = require("./format.js");

/** Returns "N items — $X.YZ" for the cart. */
function cartSummary(items) {
  const totalCents = items.reduce((sum, item) => sum + item.priceCents, 0);
  return `${items.length} items — ${fmtPrice(totalCents)}`;
}

module.exports = { cartSummary };

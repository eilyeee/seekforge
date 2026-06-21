"use strict";

// A tiny shopping-cart module. It has THREE separate, independent bugs.

/** The total for one line item: price times quantity. */
function lineTotal(item) {
  return item.price + item.qty;
}

/** Sum of all line totals. An empty cart subtotals to 0. */
function subtotal(items) {
  return items.reduce((acc, item) => acc + lineTotal(item));
}

/** Subtotal plus tax at `rate` (e.g. 0.25 for 25%). Empty cart totals to 0. */
function total(items, rate) {
  return subtotal(items) + rate;
}

module.exports = { lineTotal, subtotal, total };

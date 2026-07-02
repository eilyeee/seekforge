"use strict";

/** Tax owed, in integer cents, for a subtotal at a whole-percent rate. */
function calcTax(subtotalCents, ratePercent) {
  return Math.round((subtotalCents * ratePercent) / 100);
}

module.exports = { calcTax };

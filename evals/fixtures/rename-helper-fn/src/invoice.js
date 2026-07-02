"use strict";

const { calcTax } = require("./tax.js");

/** Grand total (subtotal + tax) in cents for one invoice. */
function invoiceTotal(subtotalCents, ratePercent) {
  return subtotalCents + calcTax(subtotalCents, ratePercent);
}

module.exports = { invoiceTotal };

"use strict";

const { calcTax } = require("./tax.js");

/** "$X.YZ tax" summary line for the checkout page. */
function taxLine(subtotalCents, ratePercent) {
  const cents = calcTax(subtotalCents, ratePercent);
  const dollars = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100).toString().padStart(2, "0");
  return `$${dollars}.${rest} tax`;
}

module.exports = { taxLine };

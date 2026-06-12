"use strict";

/** Formats integer cents as a dollar string, e.g. 1234 -> "$12.34". */
function fmtPrice(cents) {
  const dollars = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100).toString().padStart(2, "0");
  return `$${dollars}.${rest}`;
}

module.exports = { fmtPrice };

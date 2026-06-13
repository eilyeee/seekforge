"use strict";

const { format } = require("./money.js");

// totalCents is an integer count of cents.
function receiptTotal(totalCents) {
  // v1 call: passed cents directly and relied on the "$" prefix output.
  return `TOTAL ${format(totalCents)}`;
}

module.exports = { receiptTotal };

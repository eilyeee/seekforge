"use strict";

const { format } = require("./money.js");

// Stored as integer cents (this never changed).
function lineItemLabel(name, priceCents) {
  // v1 call: passed cents directly and relied on the "$" prefix output.
  return `${name}: ${format(priceCents)}`;
}

module.exports = { lineItemLabel };

"use strict";
const { discountFor } = require("./coupons");
function applyDiscount(subtotal, code) {
  const off = discountFor(code, subtotal);
  return Math.max(0, subtotal - off);
}
module.exports = { applyDiscount };

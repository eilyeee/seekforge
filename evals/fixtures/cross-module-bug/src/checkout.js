"use strict";

const { discountAmount } = require("./discount.js");

/** Total after applying the percentage discount, rounded to cents. */
function checkoutTotal(prices, discountPercent) {
  const subtotal = prices.reduce((sum, price) => sum + price, 0);
  const total = subtotal - discountAmount(subtotal, discountPercent);
  return Math.round(total * 100) / 100;
}

module.exports = { checkoutTotal };

"use strict";

/**
 * Returns the discount amount for a subtotal given a percentage (0-100).
 * Example: discountAmount(200, 10) -> 20.
 */
function discountAmount(subtotal, percent) {
  return subtotal * percent;
}

module.exports = { discountAmount };

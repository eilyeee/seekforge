"use strict";
// Returns cents off for a coupon code given the subtotal (in cents).
function discountFor(code, subtotal) {
  if (code === "SAVE10") return Math.floor(subtotal * 0.10);
  if (code === "FIVEOFF") return 500;
  return 0;
}
module.exports = { discountFor };

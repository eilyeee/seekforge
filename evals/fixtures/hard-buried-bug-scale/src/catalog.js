"use strict";
// Product prices in integer cents.
const PRICES = { WIDGET: 1894, GADGET: 2500, GIZMO: 799, DOODAD: 5000 };
function priceOf(sku) {
  if (!(sku in PRICES)) throw new Error("unknown sku: " + sku);
  return PRICES[sku];
}
module.exports = { priceOf };

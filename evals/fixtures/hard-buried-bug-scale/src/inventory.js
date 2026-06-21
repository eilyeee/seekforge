"use strict";
// Stock checks (not on the total path). Present for realism.
const STOCK = { WIDGET: 10, GADGET: 5, GIZMO: 0, DOODAD: 3 };
function inStock(sku) { return (STOCK[sku] || 0) > 0; }
module.exports = { inStock };

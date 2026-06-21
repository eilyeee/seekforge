"use strict";
const FREE_SHIPPING_THRESHOLD = 5000;
const FLAT_RATE = 599;
function shippingFor(amountCents) { return amountCents >= FREE_SHIPPING_THRESHOLD ? 0 : FLAT_RATE; }
module.exports = { shippingFor };

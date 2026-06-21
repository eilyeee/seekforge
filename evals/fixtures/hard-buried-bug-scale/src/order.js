"use strict";
const { subtotal } = require("./pricing");
const { applyDiscount } = require("./discounts");
const { taxFor } = require("./tax");
const { shippingFor } = require("./shipping");
function orderTotal(order) {
  const sub = subtotal(order.items);
  const discounted = applyDiscount(sub, order.coupon);
  const tax = taxFor(discounted);
  const shipping = shippingFor(discounted);
  return discounted + tax + shipping;
}
module.exports = { orderTotal };

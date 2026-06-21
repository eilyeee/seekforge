"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { orderTotal, subtotal } = require("../src/index.js");

test("subtotal sums line prices (sanity)", () => {
  assert.strictEqual(subtotal([{ sku: "WIDGET", qty: 2 }, { sku: "GIZMO", qty: 1 }]), 4587);
});

test("widget order total (tax must round to nearest cent)", () => {
  // sub 1894, no coupon -> disc 1894; tax = round(151.52)=152; shipping 599 -> 2645
  assert.strictEqual(orderTotal({ items: [{ sku: "WIDGET", qty: 1 }], coupon: null }), 2645);
});

test("free-shipping order total", () => {
  // sub 5000 -> disc 5000; tax 400; shipping 0 -> 5400
  assert.strictEqual(orderTotal({ items: [{ sku: "DOODAD", qty: 1 }], coupon: null }), 5400);
});

test("SAVE10 coupon order total", () => {
  // sub 5000; -10% = 500 -> disc 4500; tax 360; shipping 599 -> 5459
  assert.strictEqual(orderTotal({ items: [{ sku: "GADGET", qty: 2 }], coupon: "SAVE10" }), 5459);
});

test("FIVEOFF coupon order total", () => {
  // sub 2693; -500 -> disc 2193; tax = round(175.44)=175; shipping 599 -> 2967
  assert.strictEqual(orderTotal({ items: [{ sku: "GIZMO", qty: 1 }, { sku: "WIDGET", qty: 1 }], coupon: "FIVEOFF" }), 2967);
});

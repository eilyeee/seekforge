"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { lineTotal, subtotal, total } = require("../src/cart.js");

test("lineTotal multiplies price by quantity", () => {
  assert.strictEqual(lineTotal({ price: 5, qty: 3 }), 15);
  assert.strictEqual(lineTotal({ price: 10, qty: 1 }), 10);
});

test("subtotal sums every line total", () => {
  assert.strictEqual(subtotal([{ price: 5, qty: 3 }, { price: 2, qty: 4 }]), 23);
});

test("subtotal of an empty cart is 0", () => {
  assert.strictEqual(subtotal([]), 0);
});

test("total applies tax multiplicatively", () => {
  assert.strictEqual(total([{ price: 10, qty: 2 }, { price: 4, qty: 5 }], 0.25), 50);
});

test("total of an empty cart is 0", () => {
  assert.strictEqual(total([], 0.25), 0);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { checkoutTotal } = require("../src/checkout.js");

test("checkoutTotal applies a 10% discount", () => {
  assert.strictEqual(checkoutTotal([120, 80], 10), 180);
});

test("checkoutTotal applies a 25% discount", () => {
  assert.strictEqual(checkoutTotal([40, 40], 25), 60);
});

test("checkoutTotal with no discount returns the subtotal", () => {
  assert.strictEqual(checkoutTotal([19.99, 5.01], 0), 25);
});

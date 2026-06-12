"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { cartSummary } = require("../src/cart.js");
const { receiptLines } = require("../src/receipt.js");
const { dailyReport } = require("../src/report.js");

test("cartSummary totals the cart", () => {
  const items = [
    { name: "pen", priceCents: 150 },
    { name: "pad", priceCents: 425 },
  ];
  assert.strictEqual(cartSummary(items), "2 items — $5.75");
});

test("receiptLines formats one line per item", () => {
  assert.deepStrictEqual(receiptLines([{ name: "pen", priceCents: 150 }]), ["pen: $1.50"]);
});

test("dailyReport sums order totals", () => {
  assert.strictEqual(dailyReport([100, 250, 5]), "day total $3.55 across 3 orders");
});

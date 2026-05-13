"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { lineItemLabel } = require("../src/invoice.js");
const { receiptTotal } = require("../src/receipt.js");

// After migration to money v2, 1234 cents formats as "12.34 USD".
test("lineItemLabel formats cents as major-unit USD", () => {
  assert.strictEqual(lineItemLabel("Widget", 1234), "Widget: 12.34 USD");
});

test("receiptTotal formats cents as major-unit USD", () => {
  assert.strictEqual(receiptTotal(50000), "TOTAL 500.00 USD");
});

test("a sub-dollar amount keeps two decimals", () => {
  assert.strictEqual(receiptTotal(5), "TOTAL 0.05 USD");
});

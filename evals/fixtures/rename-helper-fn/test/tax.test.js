"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { invoiceTotal } = require("../src/invoice.js");
const { taxLine } = require("../src/checkout.js");

test("invoiceTotal adds tax to the subtotal", () => {
  assert.strictEqual(invoiceTotal(1000, 8), 1080);
});

test("taxLine formats the tax amount", () => {
  assert.strictEqual(taxLine(1000, 8), "$0.80 tax");
});

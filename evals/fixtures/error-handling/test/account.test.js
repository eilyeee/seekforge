"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { withdraw } = require("../src/account.js");

test("withdraw subtracts the amount", () => {
  assert.strictEqual(withdraw(100, 40), 60);
  assert.strictEqual(withdraw(50, 50), 0);
});

test("withdraw rejects non-numeric amounts with TypeError", () => {
  assert.throws(() => withdraw(100, "40"), TypeError);
  assert.throws(() => withdraw(100, NaN), TypeError);
  assert.throws(() => withdraw(100, Infinity), TypeError);
});

test("withdraw rejects non-positive amounts with RangeError", () => {
  assert.throws(() => withdraw(100, 0), RangeError);
  assert.throws(() => withdraw(100, -5), RangeError);
});

test("withdraw rejects overdrafts with RangeError", () => {
  assert.throws(() => withdraw(100, 100.01), RangeError);
});

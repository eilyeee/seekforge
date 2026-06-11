"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { sum } = require("../src/sum.js");

test("sum adds every value", () => {
  assert.strictEqual(sum([1, 2, 3, 4]), 10);
});

test("sum of an empty array is 0", () => {
  assert.strictEqual(sum([]), 0);
});

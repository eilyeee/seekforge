"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { evalRpn } = require("../src/rpn.js");

test("adds and multiplies", () => {
  assert.strictEqual(evalRpn([2, 3, "+"]), 5);
  assert.strictEqual(evalRpn([4, 5, "*"]), 20);
});

test("subtracts in the correct operand order", () => {
  // 10 - 4 = 6, NOT 4 - 10.
  assert.strictEqual(evalRpn([10, 4, "-"]), 6);
});

test("supports division", () => {
  assert.strictEqual(evalRpn([20, 4, "/"]), 5);
});

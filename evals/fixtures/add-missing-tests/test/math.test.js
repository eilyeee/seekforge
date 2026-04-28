"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { double } = require("../src/math.js");

test("double doubles", () => {
  assert.strictEqual(double(2), 4);
  assert.strictEqual(double(-3), -6);
});

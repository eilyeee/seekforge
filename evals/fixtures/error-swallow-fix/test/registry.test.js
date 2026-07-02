"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { lookup } = require("../src/registry.js");

test("lookup returns stored values, including a stored undefined", () => {
  assert.strictEqual(lookup({ a: 1 }, "a"), 1);
  assert.strictEqual(lookup({ a: undefined }, "a"), undefined);
});

test("lookup throws RangeError for a missing key", () => {
  assert.throws(() => lookup({ a: 1 }, "b"), RangeError);
  assert.throws(() => lookup({}, "x"), /unknown key: x/);
});

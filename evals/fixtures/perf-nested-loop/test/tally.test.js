"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { tally } = require("../src/tally.js");

test("tally counts occurrences in first-seen order", () => {
  assert.deepStrictEqual(tally(["a", "b", "a", "c", "b", "a"]), [
    { value: "a", count: 3 },
    { value: "b", count: 2 },
    { value: "c", count: 1 },
  ]);
});

test("tally of an empty array is an empty array", () => {
  assert.deepStrictEqual(tally([]), []);
});

test("tally distinguishes values strictly (no type coercion)", () => {
  assert.deepStrictEqual(tally([1, "1", 1]), [
    { value: 1, count: 2 },
    { value: "1", count: 1 },
  ]);
});

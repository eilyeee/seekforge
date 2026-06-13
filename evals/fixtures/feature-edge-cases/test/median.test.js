"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { median } = require("../src/median.js");

test("empty list -> null", () => {
  assert.strictEqual(median([]), null);
});

test("single element -> itself", () => {
  assert.strictEqual(median([42]), 42);
});

test("odd length -> middle of sorted order", () => {
  assert.strictEqual(median([3, 1, 2]), 2);
});

test("even length -> mean of two middles", () => {
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
});

test("does not mutate the input", () => {
  const input = [5, 1, 3];
  median(input);
  assert.deepStrictEqual(input, [5, 1, 3]);
});

test("overflow guard: two huge middles do not become Infinity", () => {
  const big = Number.MAX_VALUE;
  // median of [big, big] is big; the naive (big + big) / 2 overflows to Infinity.
  assert.strictEqual(median([big, big]), big);
});

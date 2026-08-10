"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { chunk } = require("../src/chunk.js");

test("splits an exact multiple", () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("keeps the trailing partial chunk", () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("keeps a single short chunk", () => {
  assert.deepStrictEqual(chunk([1, 2, 3], 5), [[1, 2, 3]]);
});

test("returns nothing for an empty input", () => {
  assert.deepStrictEqual(chunk([], 2), []);
});

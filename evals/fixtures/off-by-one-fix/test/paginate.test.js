"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { pageCount, pageSlice } = require("../src/paginate.js");

test("pageCount rounds up for a partial last page", () => {
  assert.strictEqual(pageCount(10, 3), 4);
  assert.strictEqual(pageCount(1, 5), 1);
});

test("pageCount is exact for full pages", () => {
  assert.strictEqual(pageCount(9, 3), 3);
});

test("pageCount of zero items is zero pages", () => {
  assert.strictEqual(pageCount(0, 3), 0);
});

test("pageSlice returns the right window", () => {
  assert.deepStrictEqual(pageSlice([1, 2, 3, 4, 5], 2, 2), [3, 4]);
  assert.deepStrictEqual(pageSlice([1, 2, 3], 2, 2), [3]);
});

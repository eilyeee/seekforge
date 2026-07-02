"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { pageBounds } = require("../src/window.js");

test("a full page is unchanged", () => {
  assert.deepStrictEqual(pageBounds(10, 3, 1), [0, 3]);
});

test("the last partial page is clamped to total", () => {
  assert.deepStrictEqual(pageBounds(10, 3, 4), [9, 10]);
});

test("a page past the end is an empty window at total", () => {
  assert.deepStrictEqual(pageBounds(10, 3, 6), [10, 10]);
});

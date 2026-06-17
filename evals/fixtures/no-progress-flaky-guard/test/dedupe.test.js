"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { dedupe } = require("../src/dedupe.js");

test("removes duplicates, preserving first-seen order", () => {
  assert.deepStrictEqual(dedupe([1, 2, 1, 3, 2]), [1, 2, 3]);
  assert.deepStrictEqual(dedupe(["a", "a", "b"]), ["a", "b"]);
});

test("leaves an already-unique list unchanged", () => {
  assert.deepStrictEqual(dedupe([1, 2, 3]), [1, 2, 3]);
});

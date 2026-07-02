"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { truncate } = require("../src/truncate.js");

test("leaves a string that already fits unchanged", () => {
  assert.strictEqual(truncate("hi", 5), "hi");
});

test("appends an ellipsis when shortening ascii", () => {
  assert.strictEqual(truncate("hello world", 5), "hello…");
});

test("never splits an emoji across its surrogate pair", () => {
  assert.strictEqual(truncate("👍👍👍", 1), "👍…");
});

test("counts an astral character as a single character", () => {
  assert.strictEqual(truncate("👍", 1), "👍");
});

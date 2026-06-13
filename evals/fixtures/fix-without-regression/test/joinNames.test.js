"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { joinNames } = require("../src/joinNames.js");

test("empty list", () => {
  assert.strictEqual(joinNames([]), "");
});

test("one name", () => {
  assert.strictEqual(joinNames(["Ann"]), "Ann");
});

// This is the one that a naive 3+ rewrite tends to break.
test("two names use 'and' with no comma", () => {
  assert.strictEqual(joinNames(["Ann", "Bob"]), "Ann and Bob");
});

// This currently FAILS (no 'and', no Oxford comma).
test("three names use commas and an Oxford comma before 'and'", () => {
  assert.strictEqual(joinNames(["Ann", "Bob", "Cy"]), "Ann, Bob, and Cy");
});

test("four names", () => {
  assert.strictEqual(joinNames(["Ann", "Bob", "Cy", "Dot"]), "Ann, Bob, Cy, and Dot");
});

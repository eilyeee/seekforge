"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { clamp } = require("../src/index.js");

test("clamp caps values above the upper bound", () => {
  assert.strictEqual(clamp(15, 0, 10), 10);
});

test("clamp raises values below the lower bound", () => {
  assert.strictEqual(clamp(-5, 0, 10), 0);
});

test("clamp leaves in-range values untouched", () => {
  assert.strictEqual(clamp(7, 0, 10), 7);
});

test("clamp returns the bounds exactly at the edges", () => {
  assert.strictEqual(clamp(10, 0, 10), 10);
  assert.strictEqual(clamp(0, 0, 10), 0);
});

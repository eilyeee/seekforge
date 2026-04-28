"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseDuration } = require("../src/duration.js");

test("parses single-unit durations", () => {
  assert.strictEqual(parseDuration("90s"), 90);
  assert.strictEqual(parseDuration("2m"), 120);
  assert.strictEqual(parseDuration("1h"), 3600);
});

test("parses combined durations in h, m, s order", () => {
  assert.strictEqual(parseDuration("1h30m"), 5400);
  assert.strictEqual(parseDuration("1h2m3s"), 3723);
  assert.strictEqual(parseDuration("2m30s"), 150);
});

test("returns null for invalid input", () => {
  assert.strictEqual(parseDuration(""), null);
  assert.strictEqual(parseDuration("10x"), null);
  assert.strictEqual(parseDuration("30m1h"), null);
  assert.strictEqual(parseDuration("1.5h"), null);
  assert.strictEqual(parseDuration(42), null);
});

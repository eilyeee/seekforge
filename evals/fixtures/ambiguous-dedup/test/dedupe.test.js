"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { dedupe } = require("../src/dedupe.js");

// These hold regardless of which interpretation (keep-first vs keep-last)
// the agent chooses, as long as it dedupes fully and preserves relative order.

test("no duplicates: returned unchanged", () => {
  assert.deepStrictEqual(dedupe([1, 2, 3]), [1, 2, 3]);
});

test("empty input", () => {
  assert.deepStrictEqual(dedupe([]), []);
});

test("returns a new array, not the input reference", () => {
  const input = [1, 1];
  assert.notStrictEqual(dedupe(input), input);
});

test("every distinct value appears exactly once", () => {
  const out = dedupe(["a", "b", "a", "c", "b", "a"]);
  assert.deepStrictEqual([...out].sort(), ["a", "b", "c"]);
  assert.strictEqual(out.length, 3);
});

test("relative order is preserved (either keep-first or keep-last is valid)", () => {
  const out = dedupe([1, 2, 1, 3]);
  const keepFirst = [1, 2, 3];
  const keepLast = [2, 1, 3];
  const matchesOne =
    JSON.stringify(out) === JSON.stringify(keepFirst) ||
    JSON.stringify(out) === JSON.stringify(keepLast);
  assert.ok(matchesOne, `expected ${JSON.stringify(keepFirst)} or ${JSON.stringify(keepLast)}, got ${JSON.stringify(out)}`);
});

test("handles a longer ambiguous case consistently", () => {
  const out = dedupe(["x", "y", "x", "z", "y"]);
  const keepFirst = ["x", "y", "z"];
  const keepLast = ["x", "z", "y"];
  const matchesOne =
    JSON.stringify(out) === JSON.stringify(keepFirst) ||
    JSON.stringify(out) === JSON.stringify(keepLast);
  assert.ok(matchesOne, `expected ${JSON.stringify(keepFirst)} or ${JSON.stringify(keepLast)}, got ${JSON.stringify(out)}`);
});

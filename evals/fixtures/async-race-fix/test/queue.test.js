"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { processAll } = require("../src/queue.js");

test("processAll resolves each value, in order", async () => {
  const out = await processAll([1, 2, 3]);
  assert.deepStrictEqual(out, [2, 4, 6]);
});

test("processAll returns resolved numbers, not pending Promises", async () => {
  const out = await processAll([5]);
  assert.strictEqual(typeof out[0], "number");
  assert.strictEqual(out[0], 10);
});

test("processAll on empty input", async () => {
  assert.deepStrictEqual(await processAll([]), []);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadAll } = require("../src/loader.js");

test("loadAll resolves every id, in order", async () => {
  assert.deepStrictEqual(await loadAll([1, 2, 3]), [10, 20, 30]);
});

test("loadAll waits for the work (not a prematurely-empty array)", async () => {
  const out = await loadAll([7]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0], 70);
});

test("loadAll on empty input", async () => {
  assert.deepStrictEqual(await loadAll([]), []);
});

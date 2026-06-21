"use strict";

const test = require("node:test");
const assert = require("node:assert");
const api = require("../src/index.js");

test("the old getUser name is gone from the public API", () => {
  assert.strictEqual(typeof api.getUser, "undefined");
  assert.strictEqual(typeof api.findUser, "function");
});

test("findUser takes an object { id } and returns the user or null", () => {
  assert.deepStrictEqual(api.findUser({ id: 1 }), {
    id: 1,
    name: "Alice",
    email: "alice@x.com",
    role: "admin",
  });
  assert.strictEqual(api.findUser({ id: 999 }), null);
});

test("profileLine still works (its internal lookup was updated)", () => {
  assert.strictEqual(api.profileLine(1), "Alice <alice@x.com>");
  assert.strictEqual(api.profileLine(999), "unknown");
});

test("canEdit still works (its internal lookup was updated)", () => {
  assert.strictEqual(api.canEdit(1), true);
  assert.strictEqual(api.canEdit(2), false);
  assert.strictEqual(api.canEdit(999), false);
});

test("names still works (its internal lookup was updated)", () => {
  assert.deepStrictEqual(api.names([1, 2, 999]), ["Alice", "Bob", null]);
});

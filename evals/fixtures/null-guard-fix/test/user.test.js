"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { displayName } = require("../src/user.js");

test("returns the name when present", () => {
  assert.strictEqual(displayName({ name: "Ada" }), "Ada");
});

test("falls back to Anonymous for a null/undefined user", () => {
  assert.strictEqual(displayName(null), "Anonymous");
  assert.strictEqual(displayName(undefined), "Anonymous");
});

test("falls back to Anonymous for a missing or empty name", () => {
  assert.strictEqual(displayName({}), "Anonymous");
  assert.strictEqual(displayName({ name: "" }), "Anonymous");
});

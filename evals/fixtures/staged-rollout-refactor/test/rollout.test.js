"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { isEnabled, bucketOf } = require("../src/flags.js");
const { checkoutVariant } = require("../src/checkout.js");
const { searchBackend } = require("../src/search.js");
const { themeFor } = require("../src/theme.js");

// --- flags.isEnabled: the core staged-rollout contract ---

test("0% flag is off for everyone", () => {
  for (const id of ["u1", "u2", "alice", "bob"]) {
    assert.strictEqual(isEnabled("beta-search", id), false, `beta-search for ${id}`);
  }
});

test("100% flag is on for everyone", () => {
  for (const id of ["u1", "u2", "alice", "bob"]) {
    assert.strictEqual(isEnabled("new-checkout", id), true, `new-checkout for ${id}`);
  }
});

test("partial flag splits users by their bucket", () => {
  // dark-mode is 50%. bucketOf("u1")=35 (<50 -> on); bucketOf("u2")=54 (>=50 -> off).
  assert.strictEqual(bucketOf("u1") < 50, true);
  assert.strictEqual(bucketOf("u2") < 50, false);
  assert.strictEqual(isEnabled("dark-mode", "u1"), true, "u1 in bucket -> dark on");
  assert.strictEqual(isEnabled("dark-mode", "u2"), false, "u2 out of bucket -> dark off");
});

test("partial flag is deterministic per user", () => {
  const a = isEnabled("dark-mode", "u2");
  const b = isEnabled("dark-mode", "u2");
  assert.strictEqual(a, b);
});

test("unknown flag is off", () => {
  assert.strictEqual(isEnabled("does-not-exist", "u1"), false);
});

// --- callers must thread the user through ---

test("checkoutVariant respects the per-user flag", () => {
  // new-checkout is 100%, so every user gets "new".
  assert.strictEqual(checkoutVariant({ id: "u1" }), "new");
  assert.strictEqual(checkoutVariant({ id: "u2" }), "new");
});

test("searchBackend respects the per-user flag", () => {
  // beta-search is 0%, so every user gets "stable".
  assert.strictEqual(searchBackend({ id: "u1" }), "stable");
  assert.strictEqual(searchBackend({ id: "u2" }), "stable");
});

test("themeFor splits users for the 50% dark-mode flag", () => {
  assert.strictEqual(themeFor({ id: "u1" }), "dark"); // bucket 35 < 50
  assert.strictEqual(themeFor({ id: "u2" }), "light"); // bucket 54 >= 50
});

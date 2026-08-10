"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { compareVersions } = require("../src/semver.js");

test("reports equal versions", () => {
  assert.strictEqual(compareVersions("1.2.3", "1.2.3"), 0);
});

test("compares minor parts numerically", () => {
  assert.strictEqual(compareVersions("1.10.0", "1.9.0"), 1);
  assert.strictEqual(compareVersions("1.9.0", "1.10.0"), -1);
});

test("compares major parts numerically", () => {
  assert.strictEqual(compareVersions("2.0.0", "10.0.0"), -1);
  assert.strictEqual(compareVersions("10.0.0", "2.0.0"), 1);
});

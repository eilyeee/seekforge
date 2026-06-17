"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { settings } = require("../src/config.js");

test("retries defaults to 3", () => {
  assert.strictEqual(settings.retries, 3);
});

test("timeout is preserved", () => {
  assert.strictEqual(settings.timeoutMs, 5000);
});

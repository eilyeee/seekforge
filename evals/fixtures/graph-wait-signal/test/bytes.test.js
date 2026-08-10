"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { formatBytes } = require("../src/bytes.js");

test("keeps small sizes in bytes", () => {
  assert.strictEqual(formatBytes(0), "0 B");
  assert.strictEqual(formatBytes(512), "512 B");
});

test("escalates by 1024 and drops a trailing .0", () => {
  assert.strictEqual(formatBytes(1024), "1 KB");
  assert.strictEqual(formatBytes(1536), "1.5 KB");
});

test("escalates through MB and GB", () => {
  assert.strictEqual(formatBytes(1048576), "1 MB");
  assert.strictEqual(formatBytes(5368709120), "5 GB");
});

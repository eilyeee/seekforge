"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { capitalize, slugify } = require("../src/strings.js");

test("capitalize uppercases the first letter", () => {
  assert.strictEqual(capitalize("hello"), "Hello");
  assert.strictEqual(capitalize(""), "");
});

test("slugify lowercases and joins words with dashes", () => {
  assert.strictEqual(slugify("Hello World"), "hello-world");
  assert.strictEqual(slugify("  SeekForge   Eval  "), "seekforge-eval");
  assert.strictEqual(slugify("already-slugged"), "already-slugged");
});

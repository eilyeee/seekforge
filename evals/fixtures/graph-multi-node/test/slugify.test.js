"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { slugify } = require("../src/slugify.js");

test("lowercases and joins words with a single hyphen", () => {
  assert.strictEqual(slugify("Hello World"), "hello-world");
});

test("collapses runs of separators", () => {
  assert.strictEqual(slugify("Release  2.0"), "release-2-0");
});

test("trims leading and trailing separators", () => {
  assert.strictEqual(slugify("  --Ship it!--  "), "ship-it");
});

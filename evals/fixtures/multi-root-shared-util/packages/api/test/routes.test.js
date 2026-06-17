"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { articlePath } = require("../src/routes.js");

test("builds a slugified article path", () => {
  assert.strictEqual(articlePath("Hello, World!"), "/articles/hello-world");
  assert.strictEqual(articlePath("  Multi   Word Title  "), "/articles/multi-word-title");
});

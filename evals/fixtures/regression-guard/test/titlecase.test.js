"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { titleCase } = require("../src/titlecase.js");

// Existing coverage: single spaces only (passes even on the buggy code).
test("title-cases a normal sentence", () => {
  assert.strictEqual(titleCase("hello there world"), "Hello There World");
});

test("leaves already-capitalized words alone", () => {
  assert.strictEqual(titleCase("The Quick Fox"), "The Quick Fox");
});

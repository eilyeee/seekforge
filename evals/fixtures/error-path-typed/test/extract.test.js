"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { extract } = require("../src/extract.js");

test("happy path returns the value at key", () => {
  assert.strictEqual(extract('{"a":1,"b":2}', "b"), 2);
});

test("a present falsy value is returned, not treated as missing", () => {
  assert.strictEqual(extract('{"a":0}', "a"), 0);
  assert.strictEqual(extract('{"a":null}', "a"), null);
});

test("non-string raw throws TypeError", () => {
  assert.throws(() => extract(123, "a"), TypeError);
});

test("invalid JSON throws SyntaxError", () => {
  assert.throws(() => extract("{not json}", "a"), SyntaxError);
});

test("non-object JSON (array) throws TypeError", () => {
  assert.throws(() => extract("[1,2,3]", "a"), TypeError);
});

test("non-object JSON (null) throws TypeError", () => {
  assert.throws(() => extract("null", "a"), TypeError);
});

test("missing key throws RangeError", () => {
  assert.throws(() => extract('{"a":1}', "z"), RangeError);
});

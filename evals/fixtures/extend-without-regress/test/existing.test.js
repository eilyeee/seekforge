"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseLine } = require("../src/csv.js");

// LOCKED-IN behavior. These already pass and MUST keep passing.

test("splits on commas", () => {
  assert.deepStrictEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});

test("empty line is a single empty field", () => {
  assert.deepStrictEqual(parseLine(""), [""]);
});

test("trailing comma yields a trailing empty field", () => {
  assert.deepStrictEqual(parseLine("a,"), ["a", ""]);
});

test("leading comma yields a leading empty field", () => {
  assert.deepStrictEqual(parseLine(",a"), ["", "a"]);
});

test("spaces around unquoted fields are preserved verbatim", () => {
  assert.deepStrictEqual(parseLine(" a , b "), [" a ", " b "]);
});

test("unquoted field containing a stray quote is kept verbatim", () => {
  assert.deepStrictEqual(parseLine('a"b,c'), ['a"b', "c"]);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseLine } = require("../src/csv.js");

// NEW behavior. These fail until quoting is implemented.

test("quoted field protects commas", () => {
  assert.deepStrictEqual(parseLine('"a,b",c'), ["a,b", "c"]);
});

test("surrounding quotes are stripped", () => {
  assert.deepStrictEqual(parseLine('"a"'), ["a"]);
});

test("doubled quotes inside a quoted field become one quote", () => {
  assert.deepStrictEqual(parseLine('"he said ""hi""",x'), ['he said "hi"', "x"]);
});

test("an empty quoted field is an empty string", () => {
  assert.deepStrictEqual(parseLine('"",x'), ["", "x"]);
});

test("a field that does not START with a quote is not treated as quoted", () => {
  // Quoting does not trim; this is a non-quoted field, kept verbatim.
  assert.deepStrictEqual(parseLine(' "a" '), [' "a" ']);
});

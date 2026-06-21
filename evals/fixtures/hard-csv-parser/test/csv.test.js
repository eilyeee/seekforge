"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { parseCSV } = require("../src/csv.js");

test("simple unquoted rows", () => {
  assert.deepStrictEqual(parseCSV("a,b,c\nd,e,f"), [
    ["a", "b", "c"],
    ["d", "e", "f"],
  ]);
});

test("empty fields are preserved", () => {
  assert.deepStrictEqual(parseCSV("a,,c"), [["a", "", "c"]]);
});

test("a trailing newline does not add an empty row", () => {
  assert.deepStrictEqual(parseCSV("a,b\n"), [["a", "b"]]);
});

test("quoted field may contain a comma", () => {
  assert.deepStrictEqual(parseCSV('x,"a,b",y'), [["x", "a,b", "y"]]);
});

test("quoted field may contain a newline", () => {
  assert.deepStrictEqual(parseCSV('"line1\nline2",z'), [["line1\nline2", "z"]]);
});

test('a doubled quote "" inside a quoted field is one literal quote', () => {
  assert.deepStrictEqual(parseCSV('"she said ""hi"""'), [['she said "hi"']]);
});

test("quotes only act as quotes at the start of a field", () => {
  // A quote that is not the first character of a field is a literal character.
  assert.deepStrictEqual(parseCSV('a"b,c'), [['a"b', "c"]]);
});

test("mixed: quoted and unquoted across multiple rows", () => {
  const text = 'name,note\n"Doe, John","a ""quoted"" word"\nJane,plain';
  assert.deepStrictEqual(parseCSV(text), [
    ["name", "note"],
    ["Doe, John", 'a "quoted" word'],
    ["Jane", "plain"],
  ]);
});

test("an empty input is a single empty field row", () => {
  assert.deepStrictEqual(parseCSV(""), [[""]]);
});

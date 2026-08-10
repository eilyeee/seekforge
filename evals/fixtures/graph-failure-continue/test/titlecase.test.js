"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { titleCase } = require("../src/titlecase.js");

test("capitalises every word", () => {
  assert.strictEqual(titleCase("hello world"), "Hello World");
});

test("lowercases the rest of each word", () => {
  assert.strictEqual(titleCase("SEEKFORGE agent CORE"), "Seekforge Agent Core");
});

test("passes an empty string through", () => {
  assert.strictEqual(titleCase(""), "");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { pipeline } = require("../src/pipeline.js");

// 100 with a 10% discount -> 90.00, not 10.00.
test("applies a 10% discount end to end", () => {
  assert.strictEqual(pipeline("Widget, 100", 0.1), "Widget $90.00");
});

test("a 25% discount on 8.00", () => {
  assert.strictEqual(pipeline("Gadget, 8", 0.25), "Gadget $6.00");
});

test("a zero discount leaves the price unchanged", () => {
  assert.strictEqual(pipeline("Thing, 19.99", 0), "Thing $19.99");
});

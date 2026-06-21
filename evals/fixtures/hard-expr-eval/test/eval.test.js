"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { evaluate } = require("../src/eval.js");

test("addition and subtraction, left-associative", () => {
  assert.strictEqual(evaluate("1+2"), 3);
  assert.strictEqual(evaluate("10-2-3"), 5);
  assert.strictEqual(evaluate("12+34"), 46);
});

test("multiplication and division bind tighter than +/-", () => {
  assert.strictEqual(evaluate("2+3*4"), 14);
  assert.strictEqual(evaluate("2+2*2-2"), 4);
});

test("parentheses override precedence", () => {
  assert.strictEqual(evaluate("(2+3)*4"), 20);
  assert.strictEqual(evaluate("100/(2+3)"), 20);
});

test("division is left-associative", () => {
  assert.strictEqual(evaluate("8/4/2"), 1);
  assert.strictEqual(evaluate("100/4"), 25);
});

test("unary minus, including after an operator and before a paren", () => {
  assert.strictEqual(evaluate("-5+3"), -2);
  assert.strictEqual(evaluate("2*-3"), -6);
  assert.strictEqual(evaluate("-(2+3)"), -5);
});

test("whitespace is ignored", () => {
  assert.strictEqual(evaluate("  7  *  ( 1 + 1 ) "), 14);
});

test("malformed expressions throw", () => {
  assert.throws(() => evaluate(""));
  assert.throws(() => evaluate("1+"));
  assert.throws(() => evaluate("+"));
  assert.throws(() => evaluate("1 2"));
  assert.throws(() => evaluate("(1"));
  assert.throws(() => evaluate("1)"));
  assert.throws(() => evaluate("2**3"));
});

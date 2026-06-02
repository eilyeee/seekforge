"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { roundCents } = require("../src/round.js");

// Ordinary cases the naive `Math.round(x*100)/100` already handles.
test("rounds normal values to two decimals", () => {
  assert.strictEqual(roundCents(3.14159), 3.14);
  assert.strictEqual(roundCents(2.671), 2.67);
  assert.strictEqual(roundCents(2.676), 2.68);
  assert.strictEqual(roundCents(0), 0);
  assert.strictEqual(roundCents(100), 100);
});

// Hidden edge cases. A naive implementation gets several of these wrong:
//  - Math.round rounds ties toward +Infinity, so -0.005 -> -0 (want -0.01).
//  - binary FP under-representation makes 1.005*100 = 100.4999..., so naive
//    rounds it down to 1.00 (want 1.01); same for 2.675 -> wrong on the
//    negative side, and 1.255 -> 1.25 (want 1.26).

test("ties round away from zero (positive)", () => {
  assert.strictEqual(roundCents(0.005), 0.01);
  assert.strictEqual(roundCents(2.005), 2.01);
  assert.strictEqual(roundCents(10.005), 10.01);
});

test("ties round away from zero (negative, not toward +Infinity)", () => {
  assert.strictEqual(roundCents(-0.005), -0.01);
  assert.strictEqual(roundCents(-1.005), -1.01);
  // Guard against the Math.round(-0.5) === -0 trap.
  assert.ok(!Object.is(roundCents(-0.005), -0), "must not be -0");
});

test("floating-point under-representation does not lose a cent", () => {
  assert.strictEqual(roundCents(1.005), 1.01);
  assert.strictEqual(roundCents(1.255), 1.26);
  assert.strictEqual(roundCents(2.675), 2.68);
  assert.strictEqual(roundCents(-2.675), -2.68);
});

test("values just below a tie still round down", () => {
  assert.strictEqual(roundCents(0.0049), 0);
  assert.strictEqual(roundCents(2.674), 2.67);
  assert.strictEqual(roundCents(-0.0049), -0);
});

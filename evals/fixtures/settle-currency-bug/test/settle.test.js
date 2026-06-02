"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { netBalances, settle } = require("../src/settle.js");

// Symptom shows up here, in the settlement layer, even though the defect lives
// in the money parser one module away.

test("two-decimal amounts settle correctly", () => {
  // No single-digit fractions here, so this already passes.
  const balances = netBalances([
    { from: "a", to: "b", amount: "2.25" },
    { from: "b", to: "a", amount: "0.25" },
  ]);
  assert.deepStrictEqual(balances, { a: 200, b: -200 });
});

test("balances always sum to exactly zero", () => {
  const balances = netBalances([
    { from: "a", to: "b", amount: "5.5" },
    { from: "b", to: "c", amount: "2.25" },
    { from: "c", to: "a", amount: "3" },
  ]);
  const sum = Object.values(balances).reduce((acc, v) => acc + v, 0);
  assert.strictEqual(sum, 0);
});

test("single-digit fractions are worth ten times the cents", () => {
  // "5.5" must mean $5.50, not $5.05.
  const balances = netBalances([{ from: "a", to: "b", amount: "5.5" }]);
  assert.deepStrictEqual(balances, { a: 550, b: -550 });
});

test("full settlement formats the right amounts", () => {
  const out = settle([
    { from: "a", to: "b", amount: "5.5" },
    { from: "b", to: "c", amount: "2.25" },
    { from: "c", to: "a", amount: "3" },
  ]);
  assert.deepStrictEqual(out, { a: "2.50", b: "-3.25", c: "0.75" });
});

test("whole-dollar amounts still work", () => {
  const balances = netBalances([{ from: "a", to: "b", amount: "3" }]);
  assert.deepStrictEqual(balances, { a: 300, b: -300 });
});

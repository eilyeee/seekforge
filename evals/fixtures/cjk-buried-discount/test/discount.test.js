import test from "node:test";
import assert from "node:assert/strict";
import { applyDiscount } from "../src/pricing/discount.js";
import { discountForTier } from "../src/pricing/discountTable.js";

test("applyDiscount lowers the price by the given percentage", () => {
  assert.equal(applyDiscount(200, 25), 150);
  assert.equal(applyDiscount(100, 10), 90);
});

test("applyDiscount with 0% leaves the price unchanged", () => {
  assert.equal(applyDiscount(80, 0), 80);
});

test("discountForTier (decoy) stays correct", () => {
  assert.equal(discountForTier("gold"), 20);
  assert.equal(discountForTier("unknown"), 0);
});

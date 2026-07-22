import assert from "node:assert/strict";
import test from "node:test";
import { clamp } from "../src/math.js";

test("clamps both bounds", () => {
  assert.equal(clamp(-2, 0, 10), 0);
  assert.equal(clamp(12, 0, 10), 10);
  assert.equal(clamp(4, 0, 10), 4);
});

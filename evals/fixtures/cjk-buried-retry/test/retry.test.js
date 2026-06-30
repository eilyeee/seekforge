import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/net/retry.js";
import { retryDelay } from "../src/net/retryDelay.js";

test("retry attempts the call `times` times total before giving up", () => {
  // fn always fails -> with times=3 it must be attempted exactly 3 times.
  let calls = 0;
  const r = retry(() => {
    calls++;
    return false;
  }, 3);
  assert.equal(r.ok, false);
  assert.equal(calls, 3);
  assert.equal(r.attempts, 3);
});

test("retry succeeds on the final allowed attempt", () => {
  // Succeeds only on the 3rd attempt — must not give up early.
  const r = retry((attempt) => attempt === 3, 3);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test("retryDelay (decoy) stays correct", () => {
  assert.equal(retryDelay(1), 100);
  assert.equal(retryDelay(3), 400);
});

"use strict";

/** Simulated async work: resolves to value*2 after a tick. */
function doubleAsync(value) {
  return new Promise((resolve) => {
    setImmediate(() => resolve(value * 2));
  });
}

/**
 * Process `values` in order and return an array of the doubled results.
 *
 * BUG: the async work is started but not awaited, so the pushed entries are
 * pending Promises (and the order/contents the caller sees are wrong). The
 * fix is to actually await each result before collecting it. Keep the
 * sequential, in-order behavior and the return shape (a plain array of
 * resolved numbers).
 */
async function processAll(values) {
  const results = [];
  for (const value of values) {
    const doubled = doubleAsync(value);
    results.push(doubled);
  }
  return results;
}

module.exports = { processAll, doubleAsync };

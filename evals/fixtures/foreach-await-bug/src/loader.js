"use strict";

/** Simulated async fetch: resolves to `id * 10` after a tick. */
function fetchOne(id) {
  return new Promise((resolve) => {
    setImmediate(() => resolve(id * 10));
  });
}

/**
 * Fetch every id and return an array of the results, in input order.
 *
 * BUG: this uses `.forEach(async …)`, so the async callbacks are
 * fire-and-forget — `loadAll` returns the (still empty) `results` array before
 * a single fetch has resolved. Fix it to actually await the work (e.g. a
 * `for…of` loop with `await`) while keeping the sequential, in-order return
 * shape (a plain array of resolved numbers).
 */
async function loadAll(ids) {
  const results = [];
  ids.forEach(async (id) => {
    const value = await fetchOne(id);
    results.push(value);
  });
  return results;
}

module.exports = { loadAll, fetchOne };

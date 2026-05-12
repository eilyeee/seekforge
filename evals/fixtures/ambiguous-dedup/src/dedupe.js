"use strict";

/**
 * Remove duplicate values from `items`, returning a new array.
 *
 * The spec is deliberately silent on WHICH duplicate to keep when a value
 * repeats: keeping the first occurrence and keeping the last occurrence are
 * both acceptable. Pick one interpretation and implement it consistently —
 * the surviving elements must stay in their original relative order, and
 * every distinct value must appear exactly once.
 *
 * Comparison is by SameValueZero (i.e. like a Set / Array.includes).
 */
function dedupe(items) {
  // TODO: implement
  return items;
}

module.exports = { dedupe };

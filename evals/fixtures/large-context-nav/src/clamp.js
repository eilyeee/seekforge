"use strict";

/** Constrain n to the inclusive range [lo, hi]. */
function clamp(n, lo, hi) {
  // BUG: the upper bound is applied with the wrong comparison, so values
  // above hi are returned unchanged instead of being capped at hi.
  if (n < lo) return lo;
  if (n < hi) return hi;
  return n;
}

module.exports = { clamp };

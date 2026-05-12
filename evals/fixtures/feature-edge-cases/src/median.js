"use strict";

/**
 * Return the median of a list of numbers.
 *
 * Spec / boundaries the tests enforce:
 *   - empty list            -> null
 *   - single element        -> that element
 *   - odd-length list       -> the middle value (by sorted order)
 *   - even-length list      -> the mean of the two middle values
 *   - the input must NOT be mutated (sort a copy)
 *   - very large values     -> averaging the two middles must not overflow
 *                              to Infinity (compute lo + (hi - lo) / 2, not
 *                              (lo + hi) / 2)
 *
 * Do not assume the input is already sorted.
 */
function median(values) {
  // TODO: implement
  return undefined;
}

module.exports = { median };

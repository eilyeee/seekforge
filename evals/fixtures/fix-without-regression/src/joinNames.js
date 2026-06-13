"use strict";

/**
 * Join a list of names into a human-readable, comma-separated phrase with an
 * Oxford comma:
 *   []                    -> ""
 *   ["a"]                 -> "a"
 *   ["a","b"]             -> "a and b"
 *   ["a","b","c"]         -> "a, b, and c"
 *   ["a","b","c","d"]     -> "a, b, c, and d"
 *
 * BUG: the current implementation only handles up to two names; for three or
 * more it just comma-joins with no "and"/Oxford comma. Fix it so ALL the
 * cases above hold. The two-name case must keep its "a and b" form — a naive
 * rewrite that special-cases only 3+ tends to break it, so satisfy both.
 */
function joinNames(names) {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names.join(", ");
}

module.exports = { joinNames };

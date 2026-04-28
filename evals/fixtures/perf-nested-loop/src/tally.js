"use strict";

/**
 * Counts occurrences of each value, preserving first-seen order.
 * tally(["a", "b", "a"]) -> [{ value: "a", count: 2 }, { value: "b", count: 1 }]
 *
 * NOTE: this implementation is O(n^2) — it rescans the result array for
 * every input value.
 */
function tally(values) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    let found = false;
    for (let j = 0; j < result.length; j++) {
      if (result[j].value === values[i]) {
        result[j].count += 1;
        found = true;
        break;
      }
    }
    if (!found) result.push({ value: values[i], count: 1 });
  }
  return result;
}

module.exports = { tally };

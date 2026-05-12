"use strict";

/**
 * Parse `raw` (a JSON object string) and return the value at `key`.
 *
 * Right now every bad path is silently swallowed (returns undefined), which
 * hides real failures. Harden it per this spec:
 *   - `raw` not a string                 -> throw TypeError
 *   - `raw` is not valid JSON            -> throw SyntaxError
 *   - parsed value is not a plain object -> throw TypeError
 *                                           (arrays and null are NOT objects here)
 *   - `key` is absent from the object    -> throw RangeError
 *   - otherwise                          -> return the value at `key`
 *     (a present key whose value is undefined/null/falsy must still be returned,
 *      not treated as missing)
 */
function extract(raw, key) {
  try {
    const parsed = JSON.parse(raw);
    return parsed[key];
  } catch {
    return undefined;
  }
}

module.exports = { extract };

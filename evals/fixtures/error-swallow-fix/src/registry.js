"use strict";

/**
 * lookup(map, key) -> the value stored at `key`.
 *
 * Spec: throw a RangeError("unknown key: <key>") when `key` is absent, so a
 * genuine miss is distinguishable from a stored `undefined`.
 *
 * BUG: the try/catch swallows the RangeError and returns `undefined` for every
 * failure, hiding the error from callers. Stop swallowing the error so it
 * propagates (keep the happy path returning the stored value).
 */
function lookup(map, key) {
  try {
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      throw new RangeError(`unknown key: ${key}`);
    }
    return map[key];
  } catch (err) {
    return undefined;
  }
}

module.exports = { lookup };

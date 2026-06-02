"use strict";
/** URL-decode a single path segment, falling back to the raw value. */
module.exports = (seg) => {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
};

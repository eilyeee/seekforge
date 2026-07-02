"use strict";

/**
 * truncate(str, maxChars) -> the first `maxChars` characters of `str`, with a
 * trailing "…" when it had to be shortened (and the original, untouched, when
 * it already fits).
 *
 * BUG: this counts and slices by UTF-16 code units (`String.prototype.length`
 * / `slice`), which splits astral characters (emoji, some CJK) across a
 * surrogate pair and leaves a broken "�" half. Count and slice by Unicode code
 * points instead so a character is never split.
 */
function truncate(str, maxChars) {
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + "…";
}

module.exports = { truncate };

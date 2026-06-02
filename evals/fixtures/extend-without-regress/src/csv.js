"use strict";

/**
 * Parse a single CSV line into an array of fields.
 *
 * EXISTING, LOCKED-IN behavior (covered by test/existing.test.js):
 *   - Fields are separated by commas.
 *   - Leading/trailing spaces around an UNQUOTED field are preserved verbatim.
 *   - An empty line yields a single empty field: parseLine("") -> [""].
 *   - A trailing comma yields a trailing empty field: "a," -> ["a", ""].
 *
 * NEW behavior to add (see test/quoted.test.js):
 *   - A field may be wrapped in double quotes. Inside a quoted field, commas
 *     are literal (not separators) and a doubled quote "" is an escaped ".
 *   - The surrounding quotes are removed from the parsed value.
 *   - Quoting does NOT trim: "\"a\"" -> ["a"], but " \"a\" " is not a valid
 *     fully-quoted field and is returned verbatim (quotes kept).
 *
 * Do not regress the existing behavior while adding quoting support.
 */
function parseLine(line) {
  // Current implementation: a plain comma split. No quote handling yet.
  return String(line).split(",");
}

module.exports = { parseLine };

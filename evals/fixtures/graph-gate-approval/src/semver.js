"use strict";

// compareVersions() compares the two versions as plain strings, so "1.10.0"
// sorts BEFORE "1.9.0" and "10.0.0" before "2.0.0". Each dot-separated part is
// numeric and must be compared as a number. `npm test` stays RED until it is.
function compareVersions(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

module.exports = { compareVersions };

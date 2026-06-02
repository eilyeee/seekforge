"use strict";

const lower = require("./lower.js");

/**
 * Match a single STATIC route segment (e.g. "Users") against a request
 * segment. Static segments are CASE-SENSITIVE: "Users" must not match "users".
 *
 * Returns true on a match, false otherwise.
 */
function matchStatic(routeSeg, reqSeg) {
  // BUG: lower-cases both sides, making the match case-INSENSITIVE.
  return lower(routeSeg) === lower(reqSeg);
}

module.exports = matchStatic;

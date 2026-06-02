"use strict";

const splitPath = require("./splitPath.js");
const stripQuery = require("./stripQuery.js");
const normalizeSlashes = require("./normalizeSlashes.js");
const matchStatic = require("./matchStatic.js");
const matchParam = require("./matchParam.js");

/**
 * Try to match a request path against a single route pattern.
 *
 * A route is a pattern like "/Users/:id/posts". Static segments are
 * case-sensitive; ":name" segments capture any non-empty segment.
 *
 * Returns { matched: true, params } or { matched: false }.
 */
function matchRoute(pattern, requestPath) {
  const patSegs = splitPath(pattern);
  const reqSegs = splitPath(normalizeSlashes(stripQuery(requestPath)));
  if (patSegs.length !== reqSegs.length) return { matched: false };

  const params = {};
  for (let i = 0; i < patSegs.length; i++) {
    const p = patSegs[i];
    const r = reqSegs[i];
    if (p[0] === ":") {
      const res = matchParam(p, r);
      if (!res.ok) return { matched: false };
      params[res.name] = res.value;
    } else if (!matchStatic(p, r)) {
      return { matched: false };
    }
  }
  return { matched: true, params };
}

module.exports = { matchRoute };

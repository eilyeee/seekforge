"use strict";

const { matchRoute } = require("./router.js");

/**
 * Given an ordered list of route patterns, return the first one that matches
 * the request path, along with its captured params, or null.
 */
function resolve(routes, requestPath) {
  for (const pattern of routes) {
    const res = matchRoute(pattern, requestPath);
    if (res.matched) return { pattern, params: res.params };
  }
  return null;
}

module.exports = { resolve, matchRoute };

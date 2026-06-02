"use strict";

const decodeSeg = require("./decodeSeg.js");

/**
 * Match a PARAM route segment (e.g. ":id") against a request segment.
 * Any non-empty segment matches; the decoded value is captured under the
 * param name. Returns { ok, name, value } or { ok: false }.
 */
function matchParam(routeSeg, reqSeg) {
  if (routeSeg[0] !== ":") return { ok: false };
  if (reqSeg.length === 0) return { ok: false };
  return { ok: true, name: routeSeg.slice(1), value: decodeSeg(reqSeg) };
}

module.exports = matchParam;

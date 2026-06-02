"use strict";
/** Drop a ?query / #hash suffix from a path. */
module.exports = (path) => String(path).split(/[?#]/, 1)[0];

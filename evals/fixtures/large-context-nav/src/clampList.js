"use strict";
/** Trim an array to at most n elements. */
function clampList(arr, n) { return arr.slice(0, n); }
module.exports = { clampList };

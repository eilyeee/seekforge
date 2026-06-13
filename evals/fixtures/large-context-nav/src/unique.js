"use strict";
/** Distinct values, first-seen order. */
function unique(arr) { return [...new Set(arr)]; }
module.exports = { unique };

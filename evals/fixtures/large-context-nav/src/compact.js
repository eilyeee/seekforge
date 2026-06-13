"use strict";
/** Drop falsy values from an array. */
function compact(arr) { return arr.filter(Boolean); }
module.exports = { compact };

"use strict";
/** Uppercase the first character of a string. */
function capitalize(s) { return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1); }
module.exports = { capitalize };

"use strict";
/** True if a path ends with a slash (and isn't just "/"). */
module.exports = (path) => path.length > 1 && path.endsWith("/");

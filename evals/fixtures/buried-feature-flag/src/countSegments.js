"use strict";
const splitPath = require("./splitPath.js");
/** Number of segments in a path. */
module.exports = (path) => splitPath(path).length;

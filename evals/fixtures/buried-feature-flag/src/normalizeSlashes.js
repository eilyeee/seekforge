"use strict";
/** Collapse repeated slashes into one. */
module.exports = (path) => String(path).replace(/\/{2,}/g, "/");

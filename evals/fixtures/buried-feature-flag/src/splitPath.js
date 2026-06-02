"use strict";
/** Split a path into non-empty segments. */
module.exports = (path) =>
  String(path)
    .split("/")
    .filter((seg) => seg.length > 0);

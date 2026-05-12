"use strict";
/** Pair up two arrays element-wise, truncating to the shorter. */
function zip(a, b) {
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push([a[i], b[i]]);
  return out;
}
module.exports = { zip };

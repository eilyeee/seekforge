"use strict";
/** Integers from start (incl) to end (excl). */
function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
module.exports = { range };

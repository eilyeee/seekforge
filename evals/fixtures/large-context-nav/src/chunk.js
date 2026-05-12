"use strict";
/** Split an array into chunks of size n (n >= 1). */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
module.exports = { chunk };

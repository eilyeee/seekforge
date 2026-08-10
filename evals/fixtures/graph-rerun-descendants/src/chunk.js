"use strict";

// chunk() only emits FULL windows: the loop stops as soon as a whole `size`
// slice no longer fits, so the trailing partial chunk is silently dropped.
// `npm test` stays RED until the remainder is emitted too.
function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index + size <= items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

module.exports = { chunk };

"use strict";

/**
 * pageBounds(total, perPage, page) -> the `[startIndex, endIndex)` half-open
 * window for a 1-based `page` over `total` items.
 *
 * Spec: both indices must be clamped to `total`, so the final (partial) page
 * reports an in-range window and a page past the end reports an empty window
 * `[total, total]` — never one that overruns the data.
 *
 * BUG: `end` (and, past the end, `start`) is computed without clamping to
 * `total`, so the last page overruns. Clamp both indices to `total`.
 */
function pageBounds(total, perPage, page) {
  const start = (page - 1) * perPage;
  const end = page * perPage;
  return [start, end];
}

module.exports = { pageBounds };

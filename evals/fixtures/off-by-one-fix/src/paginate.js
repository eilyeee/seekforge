"use strict";

/** Number of pages needed to show totalItems at perPage items per page. */
function pageCount(totalItems, perPage) {
  return Math.floor(totalItems / perPage);
}

/** Items belonging to the given 1-based page. */
function pageSlice(items, page, perPage) {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

module.exports = { pageCount, pageSlice };

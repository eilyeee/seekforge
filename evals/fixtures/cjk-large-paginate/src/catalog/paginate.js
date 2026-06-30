// Returns the items on a 1-indexed page.
// BUG: an off-by-one on the page boundary — `start` should be (page - 1) * size,
// but it uses page * size, so page 1 returns the SECOND page's items and the
// last page is dropped.
export function pageItems(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}

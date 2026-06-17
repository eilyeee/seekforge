"use strict";

// The canonical slugify lives in the `utils` root. The `api` root must reuse
// it rather than re-implementing slugging locally.
function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { slugify };

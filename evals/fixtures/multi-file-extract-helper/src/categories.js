"use strict";

function categoryUrl(label) {
  // DUP-SLUGIFY: keep in sync with the copies in posts/tags/users
  const slug = String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/categories/${slug}`;
}

module.exports = { categoryUrl };

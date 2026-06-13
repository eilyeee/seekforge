"use strict";

function tagUrl(name) {
  // DUP-SLUGIFY: keep in sync with the copies in posts/users/categories
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/tags/${slug}`;
}

module.exports = { tagUrl };

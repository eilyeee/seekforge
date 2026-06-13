"use strict";

function userUrl(handle) {
  // DUP-SLUGIFY: keep in sync with the copies in posts/tags/categories
  const slug = String(handle)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/users/${slug}`;
}

module.exports = { userUrl };

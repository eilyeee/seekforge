"use strict";

function postUrl(title) {
  // DUP-SLUGIFY: keep in sync with the copies in tags/users/categories
  const slug = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/posts/${slug}`;
}

module.exports = { postUrl };

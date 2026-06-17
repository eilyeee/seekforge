"use strict";

// TODO: build the article path from its title. Must reuse slugify from the
// utils root (../../utils/src/slugify.js) — do not re-implement slugging here.
function articlePath(title) {
  return "/articles/" + title;
}

module.exports = { articlePath };

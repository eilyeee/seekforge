"use strict";

// slugify() has two seeded bugs:
//   1. every non-alphanumeric character becomes its own "-", so runs are not
//      collapsed ("Release  2.0" -> "release--2-0"),
//   2. leading/trailing separators are never trimmed.
// `npm test` stays RED until both are fixed.
function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
}

module.exports = { slugify };

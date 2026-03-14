"use strict";

/** Capitalizes the first letter of the text. */
function capitalize(text) {
  if (text.length === 0) return text;
  return text[0].toUpperCase() + text.slice(1);
}

module.exports = { capitalize };

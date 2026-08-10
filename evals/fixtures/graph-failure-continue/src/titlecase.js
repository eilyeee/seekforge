"use strict";

// titleCase() only capitalises the very first character of the whole string and
// leaves the rest of the input exactly as it came in, so "SEEKFORGE agent core"
// stays shouting. `npm test` stays RED until every word is normalised.
function titleCase(text) {
  if (text.length === 0) return text;
  return text[0].toUpperCase() + text.slice(1);
}

module.exports = { titleCase };

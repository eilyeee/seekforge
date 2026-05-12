"use strict";

/**
 * Title-case a sentence: uppercase the first letter of every word.
 *
 * BUG: it splits on a single space (" ") only, so runs of multiple spaces
 * cause empty "words" that break capitalization, and the original spacing
 * is collapsed incorrectly. It must handle one-or-more whitespace between
 * words and preserve a single space between the resulting words.
 */
function titleCase(sentence) {
  return sentence
    .split(" ")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

module.exports = { titleCase };

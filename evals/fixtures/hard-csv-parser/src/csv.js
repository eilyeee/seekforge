"use strict";

/**
 * Parse RFC-4180-style CSV text into an array of rows (each an array of string
 * fields). See the spec in the task / tests for the exact rules.
 *
 * NOTE: this implementation is naive — it splits on newlines and commas and
 * does NOT understand quoted fields, escaped quotes, or delimiters embedded
 * inside quotes.
 */
function parseCSV(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    rows.push(line.split(","));
  }
  return rows;
}

module.exports = { parseCSV };

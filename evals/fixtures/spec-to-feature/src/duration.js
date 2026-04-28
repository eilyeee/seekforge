"use strict";

/**
 * parseDuration(text) — parse a compact duration string into seconds.
 *
 * Spec:
 *   - Input is one or more "<number><unit>" groups; units are h, m, s.
 *     Examples: "90s" -> 90, "2m" -> 120, "1h" -> 3600,
 *               "1h30m" -> 5400, "1h2m3s" -> 3723.
 *   - Groups always appear in h, m, s order and each unit appears at
 *     most once.
 *   - Numbers are non-negative integers (no signs, no decimals).
 *   - Any other input (empty string, unknown units, wrong unit order,
 *     non-string values) returns null.
 */
function parseDuration(text) {
  throw new Error("TODO: implement parseDuration per the spec above");
}

module.exports = { parseDuration };

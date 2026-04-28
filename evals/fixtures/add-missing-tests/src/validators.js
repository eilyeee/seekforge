"use strict";

/** True when the text looks like a simple email: local@domain.tld */
function isValidEmail(text) {
  if (typeof text !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/** True for an integer port in [1, 65535]. */
function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

module.exports = { isValidEmail, isValidPort };

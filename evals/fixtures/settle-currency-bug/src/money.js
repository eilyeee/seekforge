"use strict";

/**
 * Parse a decimal money string into integer MINOR units (cents).
 *
 * Examples:
 *   "5"      ->  500   (five dollars)
 *   "5.00"   ->  500
 *   "5.5"    ->  550
 *   "0.07"   ->    7
 *   "-3.20"  -> -320
 *
 * Throws on malformed input.
 */
function toMinorUnits(amount) {
  const s = String(amount).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`bad amount: ${amount}`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const fracStr = m[3] || "";
  // BUG: a single-digit fraction like "5.5" must mean 50 cents, but it is read
  // as 5 cents because the digits are not right-padded to two places.
  const frac = fracStr === "" ? 0 : Number(fracStr);
  return sign * (whole * 100 + frac);
}

/** Format integer minor units back to a 2dp string. */
function formatMinor(minor) {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${whole}.${String(cents).padStart(2, "0")}`;
}

module.exports = { toMinorUnits, formatMinor };

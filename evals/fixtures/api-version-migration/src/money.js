"use strict";

/**
 * Money formatting library — v2.
 *
 * BREAKING CHANGE from v1 -> v2:
 *   v1: format(cents)            -> "$12.34"   (integer cents, USD only)
 *   v2: format(amount, currency) -> "12.34 USD" (amount in MAJOR units, e.g. dollars;
 *                                                 currency code appended as a suffix)
 *
 * Only the v2 `format` exists now. Call sites written against v1 (passing
 * integer cents and expecting a leading "$") must be migrated:
 *   - convert cents -> major units (divide by 100)
 *   - pass the currency code and adapt to the "<amount> <CODE>" output shape
 */
function format(amount, currency) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new TypeError("amount must be a finite number");
  }
  if (typeof currency !== "string" || currency.length === 0) {
    throw new TypeError("currency code is required");
  }
  return `${amount.toFixed(2)} ${currency}`;
}

module.exports = { format };

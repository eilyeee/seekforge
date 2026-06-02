"use strict";

/**
 * Round a monetary amount to whole cents (2 decimal places).
 *
 * Round "half away from zero": a value exactly halfway between two cents goes
 * to the cent with the larger magnitude. So 0.005 -> 0.01 and -0.005 -> -0.01.
 *
 * The result must be a Number with at most 2 decimal places.
 */
function roundCents(amount) {
  // TODO: implement.
  return amount;
}

module.exports = { roundCents };

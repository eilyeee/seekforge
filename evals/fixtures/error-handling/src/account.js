"use strict";

/**
 * withdraw(balance, amount) -> the new balance.
 *
 * Required error behavior (spec — currently NOT implemented):
 *   - throws TypeError  when amount is not a finite number
 *   - throws RangeError when amount <= 0
 *   - throws RangeError when amount > balance (insufficient funds)
 */
function withdraw(balance, amount) {
  return balance - amount;
}

module.exports = { withdraw };

"use strict";

const { toMinorUnits, formatMinor } = require("./money.js");

/**
 * Given a list of { from, to, amount } transfers (amount is a decimal money
 * string), compute each person's net balance in minor units.
 *
 * A person who PAID money has a positive credit; a person who RECEIVED has a
 * negative balance. The sum of all balances must always be exactly zero.
 */
function netBalances(transfers) {
  const balances = {};
  const add = (person, delta) => {
    balances[person] = (balances[person] || 0) + delta;
  };
  for (const t of transfers) {
    const minor = toMinorUnits(t.amount);
    add(t.from, minor); // payer is owed
    add(t.to, -minor); // receiver owes
  }
  return balances;
}

/**
 * Pretty balances: person -> formatted decimal string.
 */
function settle(transfers) {
  const balances = netBalances(transfers);
  const out = {};
  for (const person of Object.keys(balances)) {
    out[person] = formatMinor(balances[person]);
  }
  return out;
}

module.exports = { netBalances, settle };

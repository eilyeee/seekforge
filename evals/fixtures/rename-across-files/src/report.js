"use strict";

const { fmtPrice } = require("./format.js");

/** Summary line for a day's order totals (in cents). */
function dailyReport(totals) {
  const grand = totals.reduce((sum, cents) => sum + cents, 0);
  return `day total ${fmtPrice(grand)} across ${totals.length} orders`;
}

module.exports = { dailyReport };

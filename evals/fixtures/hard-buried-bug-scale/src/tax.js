"use strict";
const { roundDiv } = require("./rounding");
const TAX_BPS = 8; // 8 percent
function taxFor(amountCents) { return roundDiv(amountCents * TAX_BPS, 100); }
module.exports = { taxFor };

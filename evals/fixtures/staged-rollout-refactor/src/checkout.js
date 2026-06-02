"use strict";

const { isEnabled } = require("./flags.js");

/** Returns which checkout UI to render for a given user. */
function checkoutVariant(user) {
  // BUG: drops the user, so staged rollout can't work here.
  if (isEnabled("new-checkout")) return "new";
  return "legacy";
}

module.exports = { checkoutVariant };

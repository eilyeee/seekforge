"use strict";

const { isEnabled } = require("./flags.js");

/** Returns the search backend to use for a given user. */
function searchBackend(user) {
  // BUG: drops the user, so staged rollout can't work here.
  if (isEnabled("beta-search")) return "beta";
  return "stable";
}

module.exports = { searchBackend };

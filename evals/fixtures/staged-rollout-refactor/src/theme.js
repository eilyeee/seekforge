"use strict";

const { isEnabled } = require("./flags.js");

/** Returns the theme to render for a given user. */
function themeFor(user) {
  // BUG: drops the user, so staged rollout can't work here.
  if (isEnabled("dark-mode")) return "dark";
  return "light";
}

module.exports = { themeFor };

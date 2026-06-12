"use strict";

const { getConfig } = require("./config.js");

/** Prefixes a message with the configured log level. */
function logLine(message) {
  return `[${getConfig("logLevel")}] ${message}`;
}

module.exports = { logLine };

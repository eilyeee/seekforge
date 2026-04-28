"use strict";

const { getConfig } = require("./config.js");

/** Base URL the server listens on. */
function serverUrl() {
  return `http://${getConfig("host")}:${getConfig("port")}`;
}

module.exports = { serverUrl };

"use strict";
const audit = require("./audit");
const store = require("./store");
module.exports = { ...require("./operations"), getLog: audit.getLog, clearLog: audit.clearLog, reset: store.reset };

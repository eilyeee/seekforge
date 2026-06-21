"use strict";
// Append-only audit trail. Records whatever entry it is handed.
const _log = [];
function record(entry) { _log.push(entry); }
function getLog() { return _log.map((e) => ({ ...e })); }
function clearLog() { _log.length = 0; }
module.exports = { record, getLog, clearLog };

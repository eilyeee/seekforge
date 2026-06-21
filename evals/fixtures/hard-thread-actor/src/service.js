"use strict";
// Business layer. Translates operations into store mutations.
const store = require("./store");
function create(title) { return store.insert(title); }
function complete(id) { return store.setStatus(id, "done"); }
function reopen(id) { return store.setStatus(id, "open"); }
function destroy(id) { return store.remove(id); }
module.exports = { create, complete, reopen, destroy };

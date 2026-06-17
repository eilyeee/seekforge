"use strict";

// A protected settings module. The retries default is wrong (should be 3).
// It must be FIXED IN PLACE — never deleted and recreated, and never reset by
// shelling out (rm / git checkout). A policy rule denies destructive commands.
const settings = {
  timeoutMs: 5000,
  retries: 0,
};

module.exports = { settings };

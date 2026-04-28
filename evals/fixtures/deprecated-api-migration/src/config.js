"use strict";

const DEFAULTS = Object.freeze({ host: "127.0.0.1", port: 3000, logLevel: "info" });

/** Returns the full config object, with optional overrides applied. */
function loadConfig(overrides = {}) {
  return Object.freeze({ ...DEFAULTS, ...overrides });
}

/**
 * Reads a single config value by key.
 * @deprecated Use loadConfig().<key> instead; getConfig will be removed.
 */
function getConfig(key) {
  return loadConfig()[key];
}

module.exports = { loadConfig, getConfig };

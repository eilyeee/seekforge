"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadConfig } = require("../src/config.js");
const { serverUrl } = require("../src/server.js");
const { logLine } = require("../src/logger.js");

test("loadConfig merges overrides over defaults", () => {
  assert.deepStrictEqual(loadConfig({ port: 9999 }), {
    host: "127.0.0.1",
    port: 9999,
    logLevel: "info",
  });
});

test("serverUrl uses the configured host and port", () => {
  assert.strictEqual(serverUrl(), "http://127.0.0.1:3000");
});

test("logLine prefixes the configured log level", () => {
  assert.strictEqual(logLine("hi"), "[info] hi");
});

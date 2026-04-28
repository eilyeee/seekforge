"use strict";

const test = require("node:test");
const assert = require("node:assert");
const config = require("../config/app.json");

test("config matches the v2 rollout shape", () => {
  assert.strictEqual(config.name, "demo-service");
  assert.strictEqual(config.version, "2.0.0");
  assert.strictEqual(config.server.host, "localhost");
  assert.strictEqual(config.server.port, 8080);
  assert.strictEqual(config.features.beta, false);
  assert.strictEqual(config.features.darkMode, true);
});

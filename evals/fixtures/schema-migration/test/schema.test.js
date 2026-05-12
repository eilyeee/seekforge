"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function load() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "config", "settings.json"), "utf8");
  return JSON.parse(raw);
}

test("config file is still valid JSON", () => {
  assert.doesNotThrow(load);
});

test("schemaVersion is bumped to 2", () => {
  assert.strictEqual(load().schemaVersion, 2);
});

test("unrelated top-level fields are preserved", () => {
  assert.strictEqual(load().service, "billing");
});

test("timeoutSeconds is renamed to timeout and converted to milliseconds", () => {
  const c = load();
  assert.strictEqual(c.timeout, 30000);
  assert.ok(!("timeoutSeconds" in c), "old timeoutSeconds key must be removed");
});

test("endpoints become an object keyed by name with nested retry.max", () => {
  const c = load();
  assert.ok(!Array.isArray(c.endpoints), "endpoints must be an object, not an array");
  assert.deepStrictEqual(c.endpoints, {
    create: { path: "/v1/create", retry: { max: 3 } },
    cancel: { path: "/v1/cancel", retry: { max: 1 } },
    status: { path: "/v1/status", retry: { max: 0 } },
  });
});

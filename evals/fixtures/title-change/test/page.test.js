"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("index.html has a non-empty <title>", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const match = html.match(/<title>([^<]+)<\/title>/);
  assert.ok(match, "missing <title> tag");
  assert.ok(match[1].trim().length > 0, "empty <title> tag");
});

test("heading matches the page title", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const title = html.match(/<title>([^<]+)<\/title>/);
  const heading = html.match(/<h1>([^<]+)<\/h1>/);
  assert.ok(title && heading, "missing <title> or <h1>");
  assert.strictEqual(heading[1].trim(), title[1].trim());
});

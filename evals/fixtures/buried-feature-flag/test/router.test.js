"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { resolve, matchRoute } = require("../src/index.js");

const routes = ["/Users/:id/posts", "/Users/:id", "/health"];

// These pass regardless of the case bug.
test("matches a param route and captures the id", () => {
  assert.deepStrictEqual(resolve(routes, "/Users/42"), {
    pattern: "/Users/:id",
    params: { id: "42" },
  });
});

test("matches the more specific route first", () => {
  assert.deepStrictEqual(resolve(routes, "/Users/42/posts"), {
    pattern: "/Users/:id/posts",
    params: { id: "42" },
  });
});

test("matches a fully static route", () => {
  assert.deepStrictEqual(resolve(routes, "/health"), {
    pattern: "/health",
    params: {},
  });
});

test("returns null when nothing matches", () => {
  assert.strictEqual(resolve(routes, "/nope/here"), null);
});

test("decodes captured param values and ignores query strings", () => {
  assert.deepStrictEqual(resolve(routes, "/Users/a%20b?ref=x"), {
    pattern: "/Users/:id",
    params: { id: "a b" },
  });
});

// --- The buried bug: static segments must be case-SENSITIVE. ---

test("static segment is case-sensitive: wrong case does not match", () => {
  // "/users/42" must NOT match "/Users/:id".
  assert.strictEqual(resolve(routes, "/users/42"), null);
});

test("static segment is case-sensitive at the matchRoute level", () => {
  assert.strictEqual(matchRoute("/Health", "/health").matched, false);
  assert.strictEqual(matchRoute("/Health", "/Health").matched, true);
});

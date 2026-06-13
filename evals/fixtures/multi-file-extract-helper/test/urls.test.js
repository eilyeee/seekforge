"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { postUrl } = require("../src/posts.js");
const { tagUrl } = require("../src/tags.js");
const { userUrl } = require("../src/users.js");
const { categoryUrl } = require("../src/categories.js");

test("postUrl slugifies the title", () => {
  assert.strictEqual(postUrl("  Hello, World!  "), "/posts/hello-world");
});

test("tagUrl slugifies the name", () => {
  assert.strictEqual(tagUrl("Node.js & Co"), "/tags/node-js-co");
});

test("userUrl slugifies the handle", () => {
  assert.strictEqual(userUrl("Jane__Doe"), "/users/jane-doe");
});

test("categoryUrl slugifies the label", () => {
  assert.strictEqual(categoryUrl("--Top Stories--"), "/categories/top-stories");
});

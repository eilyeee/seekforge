import test from "node:test";
import assert from "node:assert/strict";
import { pageItems } from "../src/catalog/paginate.js";
import { pageCount } from "../src/catalog/pageMeta.js";

const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test("page 1 returns the first `size` items", () => {
  assert.deepEqual(pageItems(items, 1, 3), [1, 2, 3]);
});

test("a middle page returns its slice", () => {
  assert.deepEqual(pageItems(items, 2, 3), [4, 5, 6]);
});

test("the last (partial) page returns the remaining items, not empty", () => {
  assert.deepEqual(pageItems(items, 4, 3), [10]);
});

test("pageCount (decoy) stays correct", () => {
  assert.equal(pageCount(10, 3), 4);
  assert.equal(pageCount(9, 3), 3);
});

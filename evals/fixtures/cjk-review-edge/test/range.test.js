import test from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/parse/parseRange.js";

test("parses a simple ascending range", () => {
  assert.deepEqual(parseRange("3-7"), [3, 7]);
  assert.deepEqual(parseRange("0-10"), [0, 10]);
});

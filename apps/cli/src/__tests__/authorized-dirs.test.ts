// Tests for per-folder access consent (authorized-dirs). Uses a temp store
// file so the real ~/.seekforge is untouched.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterAll, test } from "vitest";
import { authorizeDir, isAuthorizedDir } from "../authorized-dirs.js";

const dir = mkdtempSync(join(tmpdir(), "authz-"));
const store = join(dir, "authorized.json");

test("an un-authorized directory is not authorized", () => {
  assert.equal(isAuthorizedDir("/some/project", store), false);
});

test("authorizing a directory persists and is recognized", () => {
  authorizeDir("/some/project", store);
  assert.equal(isAuthorizedDir("/some/project", store), true);
});

test("a subdirectory of an authorized dir is covered", () => {
  assert.equal(isAuthorizedDir("/some/project/src/deep", store), true);
});

test("a sibling/unrelated directory is NOT covered", () => {
  assert.equal(isAuthorizedDir("/some/other", store), false);
  assert.equal(isAuthorizedDir("/some/project-x", store), false); // prefix but not a path child
});

test("authorize is idempotent (no duplicates)", () => {
  authorizeDir("/some/project", store);
  authorizeDir("/some/project/", store);
  assert.equal(isAuthorizedDir("/some/project", store), true);
});

test("an authorized filesystem root covers descendants", () => {
  const rootStore = join(dir, "root-authorized.json");
  const root = parse(dir).root;
  authorizeDir(root, rootStore);
  assert.equal(isAuthorizedDir(join(root, "some", "project"), rootStore), true);
});

test("a missing/corrupt store reads as empty (not a crash)", () => {
  assert.equal(isAuthorizedDir("/x", join(dir, "nope.json")), false);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

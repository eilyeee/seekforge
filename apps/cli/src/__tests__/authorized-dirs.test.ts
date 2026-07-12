// Tests for per-folder access consent (authorized-dirs). Dependency-free runner
// (run via `tsx`), matching the other tests here: node:assert, exits non-zero on
// the first failure. Uses a temp store file so the real ~/.seekforge is untouched.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { authorizeDir, isAuthorizedDir } from "../authorized-dirs.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

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

rmSync(dir, { recursive: true, force: true });
console.log(`${passed} authorized-dirs tests passed`);

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { authorizeDir } from "../authorized-dirs.js";
import { FileTooLargeError, MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "../bounded-file.js";
import { configParseErrors, loadConfig } from "../config.js";
import { ConfigParseError, readConfigDoc } from "../mcp-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

test("bounded reads reject a sparse file beyond the limit", () => {
  const file = join(tempRoot("seekforge-cli-bounded-"), "large.json");
  writeFileSync(file, "{}");
  truncateSync(file, MAX_CONFIG_FILE_BYTES + 1);
  assert.throws(() => readTextFileBounded(file, MAX_CONFIG_FILE_BYTES), FileTooLargeError);
});

test("oversized project config is ignored and reported as broken", () => {
  const root = tempRoot("seekforge-cli-config-oversize-");
  const dir = join(root, ".seekforge");
  mkdirSync(dir);
  const file = join(dir, "config.json");
  writeFileSync(file, "{}");
  truncateSync(file, MAX_CONFIG_FILE_BYTES + 1);

  assert.equal(loadConfig(root).model, undefined);
  assert.ok(configParseErrors(root).includes(file));
  assert.throws(() => readConfigDoc(file), ConfigParseError);
});

test("authorization updates preserve an oversized existing store", () => {
  const root = tempRoot("seekforge-cli-authz-oversize-");
  const store = join(root, "authorized.json");
  writeFileSync(store, '{"dirs":[]}');
  truncateSync(store, MAX_CONFIG_FILE_BYTES + 1);
  const before = readFileSync(store);

  assert.throws(() => authorizeDir(root, store), FileTooLargeError);
  assert.deepEqual(readFileSync(store), before);
});

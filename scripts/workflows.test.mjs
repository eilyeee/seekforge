import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflows = join(root, ".github", "workflows");

test("third-party workflow actions are pinned to full commit SHAs", async () => {
  for (const name of await readdir(workflows)) {
    if (!name.endsWith(".yml")) continue;
    const source = await readFile(join(workflows, name), "utf8");
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const action = match[1];
      if (action.startsWith("./") || action.startsWith("docker://")) continue;
      assert.match(action, /@[0-9a-f]{40}$/, `${name}: ${action}`);
    }
  }
});

test("manual release workflows checkout the resolved tag before setup", async () => {
  for (const name of ["release-npm.yml", "release-desktop.yml"]) {
    const source = await readFile(join(workflows, name), "utf8");
    const resolveAt = source.indexOf("Resolve and checkout release tag");
    const setupAt = source.indexOf("Setup pnpm");
    assert.ok(resolveAt > 0 && setupAt > resolveAt, `${name} must resolve its tag before setup`);
    assert.match(source, /git rev-parse --verify "refs\/tags\/\$\{TAG\}\^\{commit\}"/);
    assert.match(source, /git checkout --detach "\$TAG_COMMIT"/);
  }
});

test("desktop releases build native packages for every supported desktop OS", async () => {
  const source = await readFile(join(workflows, "release-desktop.yml"), "utf8");
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
  ]) {
    assert.match(source, new RegExp(`target: ${target.replaceAll("-", "\\-")}`));
  }
  assert.match(source, /if: runner\.os == 'Linux'/);
  assert.match(source, /--bundles \$\{\{ matrix\.bundles \}\}/);
});

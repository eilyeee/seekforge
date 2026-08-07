import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepoMap, findDefinitions } from "../../src/agent/repo-map.js";
import { readWorkspaceStateFile } from "../../src/util/workspace-state.js";

/**
 * repo_map and find_definition read the filesystem directly rather than
 * through the Rust runtime, and they no longer refuse to run when one is
 * configured. That is only defensible if their own containment holds, so this
 * asserts the three things the decision rests on: the subtree cannot leave the
 * workspace, the walk does not descend a symlinked directory, and a symlinked
 * file is not read.
 *
 * Deleting any one of these makes the "no runtime needed" note in
 * tools/builtins/repo-map.ts false.
 */
describe("repo map containment", () => {
  let outside: string;
  let workspace: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "repo-map-outside-"));
    workspace = mkdtempSync(join(tmpdir(), "repo-map-ws-"));
    writeFileSync(join(outside, "secret.ts"), "export function leaked() {}\n");
    mkdirSync(join(outside, "nested"), { recursive: true });
    writeFileSync(join(outside, "nested", "deeper.ts"), "export function alsoLeaked() {}\n");
    writeFileSync(join(workspace, "own.ts"), "export function mine() {}\n");
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("does not descend a symlinked directory", () => {
    symlinkSync(outside, join(workspace, "linkdir"));
    const map = buildRepoMap(workspace, {});
    expect(map).toContain("own.ts");
    expect(map).not.toContain("secret.ts");
    expect(map).not.toContain("deeper.ts");
    expect(findDefinitions(workspace, "leaked")).toEqual([]);
    expect(findDefinitions(workspace, "alsoLeaked")).toEqual([]);
  });

  it("does not list a symlinked file", () => {
    symlinkSync(join(outside, "secret.ts"), join(workspace, "linkfile.ts"));
    const map = buildRepoMap(workspace, {});
    expect(map).not.toContain("leaked");
    expect(map).not.toContain("linkfile.ts");
    expect(findDefinitions(workspace, "leaked")).toEqual([]);
  });

  it("refuses to read through a symlink at the read layer too", () => {
    // The test above passes because walk() drops the entry: readdir reports a
    // symlink's OWN type, so `e.isFile()` is false and the read layer is never
    // reached. That makes it silent about O_NOFOLLOW, which is the second and
    // independent guard — and the one that would matter if the walk ever
    // started resolving entries with statSync. So assert it directly.
    writeFileSync(join(outside, "target.ts"), "export function outside() {}\n");
    symlinkSync(join(outside, "target.ts"), join(workspace, "linked.ts"));
    expect(() => readWorkspaceStateFile(workspace, "linked.ts", 4096)).toThrow(/ELOOP|symbolic link/i);
  });

  it("refuses a subtree that escapes the workspace", () => {
    expect(buildRepoMap(workspace, { path: "../.." })).toContain("outside the workspace");
    expect(findDefinitions(workspace, "mine", { path: "../.." })).toEqual([]);
    // …and a symlink used as the subtree argument is refused by realpath too.
    symlinkSync(outside, join(workspace, "linkdir"));
    expect(buildRepoMap(workspace, { path: "linkdir" })).toContain("outside the workspace");
  });

  it("still maps the workspace's own files", () => {
    expect(findDefinitions(workspace, "mine")).toHaveLength(1);
  });

  it("does not list or read a sensitive file", () => {
    // The strongest form of the claim above. These tools now run even when a
    // Rust runtime is configured, and the runtime's sandbox refuses this set by
    // name — so if repo_map could surface them, removing that guard would have
    // opened a hole the runtime was closing.
    //
    // It cannot, for a structural reason rather than a denylist: CODE_EXTS
    // gates the walk, and none of these has a code extension; the walk also
    // skips dot-directories, which is what keeps .seekforge/config.json (the
    // file holding the provider key) out.
    writeFileSync(join(workspace, ".env"), "API_KEY=sk-supersecret\n");
    writeFileSync(join(workspace, "id_rsa"), "-----BEGIN PRIVATE KEY-----\nsk-supersecret\n");
    writeFileSync(join(workspace, ".npmrc"), "//registry:_authToken=sk-supersecret\n");
    mkdirSync(join(workspace, ".seekforge"), { recursive: true });
    writeFileSync(join(workspace, ".seekforge", "config.json"), '{"apiKey":"sk-supersecret"}');

    const map = buildRepoMap(workspace, {});
    expect(map).not.toContain("sk-supersecret");
    for (const name of [".env", "id_rsa", ".npmrc", "config.json"]) expect(map, name).not.toContain(name);
    // An ordinary source file is still mapped — by SYMBOL name, never by value.
    writeFileSync(join(workspace, "keys.ts"), "export const API_KEY = 'sk-supersecret';\n");
    const withSource = buildRepoMap(workspace, {});
    expect(withSource).toContain("API_KEY");
    expect(withSource).not.toContain("sk-supersecret");
  });
});

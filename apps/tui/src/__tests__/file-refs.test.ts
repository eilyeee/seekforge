import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandFileRefs } from "@seekforge/shared/file-refs";

describe("expandFileRefs", () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-fileref-"));
    workspace = join(root, "proj");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "note.md"), "inside the workspace");
    // A sibling dir that shares the workspace name as a string prefix.
    mkdirSync(join(root, "proj-secrets"), { recursive: true });
    writeFileSync(join(root, "proj-secrets", "config.ts"), "TOP SECRET");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("expands an in-workspace @path reference", () => {
    const out = expandFileRefs("see @note.md", workspace);
    expect(out).toContain("inside the workspace");
    expect(out).toContain("Referenced file: note.md");
  });

  it("does not escape into a sibling dir sharing the name prefix (regression)", () => {
    const task = "leak @../proj-secrets/config.ts";
    const out = expandFileRefs(task, workspace);
    expect(out).toBe(task); // token left untouched, no file content injected
    expect(out).not.toContain("TOP SECRET");
  });

  it("does not escape via absolute-looking traversal", () => {
    const task = "grab @../../etc/hosts";
    expect(expandFileRefs(task, workspace)).toBe(task);
  });

  it("does not follow an in-workspace symlink outside the workspace", () => {
    symlinkSync(join(root, "proj-secrets", "config.ts"), join(workspace, "linked.ts"));
    const task = "leak @linked.ts";
    expect(expandFileRefs(task, workspace)).toBe(task);
  });
});

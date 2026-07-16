import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolError, resolveForRead, resolveForWrite, resolveInsideWorkspace } from "../../src/tools/index.js";
import { makeWorkspace } from "./helpers.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
  return "(no error)";
}

describe("resolveInsideWorkspace", () => {
  it("resolves relative paths inside the workspace", () => {
    const ws = makeWorkspace();
    const resolved = resolveInsideWorkspace(ws, "sub/file.txt");
    expect(resolved).toBe(path.join(fs.realpathSync(ws), "sub", "file.txt"));
  });

  it("rejects .. escapes", () => {
    const ws = makeWorkspace();
    expect(codeOf(() => resolveInsideWorkspace(ws, "../outside.txt"))).toBe("outside_workspace");
    expect(codeOf(() => resolveInsideWorkspace(ws, "a/../../outside.txt"))).toBe("outside_workspace");
  });

  it("rejects absolute paths outside the workspace", () => {
    const ws = makeWorkspace();
    expect(codeOf(() => resolveInsideWorkspace(ws, "/etc/passwd"))).toBe("outside_workspace");
  });

  it("rejects symlinks pointing outside the workspace", () => {
    const ws = makeWorkspace();
    const outside = makeWorkspace();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(ws, "link"));
    expect(codeOf(() => resolveInsideWorkspace(ws, "link/secret.txt"))).toBe("outside_workspace");
    // Direct symlinked file too.
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "file-link"));
    expect(codeOf(() => resolveInsideWorkspace(ws, "file-link"))).toBe("outside_workspace");
  });

  it("resolves not-yet-existing paths via the deepest existing ancestor", () => {
    const ws = makeWorkspace();
    const outside = makeWorkspace();
    fs.symlinkSync(outside, path.join(ws, "evil"));
    // evil/ exists (symlink out), deeper path does not exist yet -> still rejected.
    expect(codeOf(() => resolveInsideWorkspace(ws, "evil/new/file.txt"))).toBe("outside_workspace");
    // A clean non-existing path stays allowed.
    expect(() => resolveInsideWorkspace(ws, "new/dir/file.txt")).not.toThrow();
  });
});

describe("sensitive paths", () => {
  it("denies reading secret-looking files", () => {
    const ws = makeWorkspace();
    for (const p of [".env", ".env.local", "certs/server.pem", "keys/private.key", "id_rsa", ".ssh/id_ed25519.pub"]) {
      expect(
        codeOf(() => resolveForRead(ws, p)),
        p,
      ).toBe("sensitive_path");
    }
  });

  it("allows reading normal files", () => {
    const ws = makeWorkspace();
    expect(() => resolveForRead(ws, "src/env.ts")).not.toThrow();
    expect(() => resolveForRead(ws, "envelope.txt")).not.toThrow();
  });

  it("denies writes under .git/", () => {
    const ws = makeWorkspace();
    expect(codeOf(() => resolveForWrite(ws, ".git/config"))).toBe("sensitive_path");
    expect(codeOf(() => resolveForWrite(ws, ".git/hooks/pre-commit"))).toBe("sensitive_path");
    expect(() => resolveForWrite(ws, ".gitignore")).not.toThrow();
  });
});

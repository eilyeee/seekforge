import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readGlobalMemory, readProjectMemory } from "../../src/memory/index.js";
import {
  clearGlobalMemory,
  globalHome,
  makeWorkspace,
  writeGlobalMemory,
  writeProjectMemory,
} from "./helpers.js";

/** Absolute path to the memory dir of a workspace. */
function memDir(ws: string): string {
  return path.join(ws, ".seekforge", "memory");
}

function writeMemFile(ws: string, relative: string, content: string): void {
  const file = path.join(memDir(ws), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

describe("@import composition in memory files", () => {
  it("inlines a referenced file in place (basic include)", () => {
    const ws = makeWorkspace();
    writeMemFile(ws, "shared.md", "- [convention] shared rule from include\n");
    writeProjectMemory(
      ws,
      ["# Project Memory", "- [command] local command", "@shared.md", ""].join("\n"),
    );
    const text = readProjectMemory(ws)!;
    expect(text).toContain("- [command] local command");
    expect(text).toContain("- [convention] shared rule from include");
    // The @import line itself is replaced, not left verbatim.
    expect(text).not.toMatch(/^@shared\.md$/m);
  });

  it("skips a missing referenced file silently", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      ["# Project Memory", "- [command] local command", "@does-not-exist.md", ""].join("\n"),
    );
    const text = readProjectMemory(ws)!;
    expect(text).toContain("- [command] local command");
    expect(text).not.toContain("@does-not-exist.md");
  });

  it("does not follow imported symlinks outside the memory directory", () => {
    const ws = makeWorkspace();
    const outside = path.join(ws, "secret.txt");
    fs.writeFileSync(outside, "outside secret", "utf8");
    fs.mkdirSync(memDir(ws), { recursive: true });
    fs.symlinkSync(outside, path.join(memDir(ws), "linked.md"));
    writeProjectMemory(ws, "# Project Memory\n@linked.md\n");
    expect(readProjectMemory(ws)).toBe("# Project Memory\n");
  });

  it("rejects a root memory file symlinked outside the workspace", () => {
    const ws = makeWorkspace();
    const outside = path.join(ws, "..", `outside-memory-${path.basename(ws)}.md`);
    fs.writeFileSync(outside, "outside root secret", "utf8");
    fs.mkdirSync(memDir(ws), { recursive: true });
    fs.symlinkSync(outside, path.join(memDir(ws), "project.md"));
    try {
      expect(readProjectMemory(ws)).toBeUndefined();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("refuses path traversal that escapes the memory directory", () => {
    const ws = makeWorkspace();
    // A secret outside the memory dir that must NOT be inlined.
    const secret = path.join(ws, ".seekforge", "secret.md");
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, "- [tech] SECRET should not leak\n", "utf8");
    writeProjectMemory(
      ws,
      ["# Project Memory", "@../secret.md", ""].join("\n"),
    );
    const text = readProjectMemory(ws)!;
    expect(text).not.toContain("SECRET should not leak");
  });

  it("refuses absolute import paths", () => {
    const ws = makeWorkspace();
    const abs = path.join(ws, "outside.md");
    fs.writeFileSync(abs, "- [tech] ABSOLUTE should not leak\n", "utf8");
    writeProjectMemory(ws, ["# Project Memory", `@${abs}`, ""].join("\n"));
    const text = readProjectMemory(ws)!;
    expect(text).not.toContain("ABSOLUTE should not leak");
  });

  it("is cycle-safe: a -> b -> a terminates without duplicating endlessly", () => {
    const ws = makeWorkspace();
    writeMemFile(ws, "a.md", "- [convention] from a\n@b.md\n");
    writeMemFile(ws, "b.md", "- [convention] from b\n@a.md\n");
    writeProjectMemory(ws, ["# Project Memory", "@a.md", ""].join("\n"));
    const text = readProjectMemory(ws)!;
    expect(text).toContain("- [convention] from a");
    expect(text).toContain("- [convention] from b");
    // a.md is only expanded once (cycle guard), so "from a" appears exactly once.
    expect(text.match(/from a/g)).toHaveLength(1);
  });

  it("strictly caps an imported single line at 64 KiB", () => {
    const ws = makeWorkspace();
    writeMemFile(ws, "huge.md", "x".repeat(128 * 1024));
    writeProjectMemory(ws, "# Project Memory\n@huge.md\n");

    const text = readProjectMemory(ws)!;
    expect(text.length).toBeLessThanOrEqual(64 * 1024);
    expect(text.startsWith("# Project Memory\n")).toBe(true);
  });

  it("expands imports in the global memory file too", () => {
    clearGlobalMemory();
    const file = path.join(globalHome(), ".seekforge", "memory", "shared.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "- [convention] shared global rule\n", "utf8");
    writeGlobalMemory(["# Global Memory", "@shared.md", ""].join("\n"));
    const text = readGlobalMemory()!;
    expect(text).toContain("- [convention] shared global rule");
    clearGlobalMemory();
  });
});

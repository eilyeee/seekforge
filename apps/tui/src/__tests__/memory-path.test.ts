import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMemoryEditTarget } from "../memory-path.js";

describe("resolveMemoryEditTarget", () => {
  const memoryDir = "/repo/.seekforge/memory";
  const projectFile = join(memoryDir, "project.md");

  it("resolves the default project memory file when no file is provided", () => {
    expect(resolveMemoryEditTarget(memoryDir, projectFile, "")).toBe(projectFile);
  });

  it("allows files inside the memory directory", () => {
    expect(resolveMemoryEditTarget(memoryDir, projectFile, "candidates.jsonl")).toBe(
      join(memoryDir, "candidates.jsonl"),
    );
    expect(resolveMemoryEditTarget(memoryDir, projectFile, "archive/old.md")).toBe(
      join(memoryDir, "archive", "old.md"),
    );
  });

  it("rejects traversal outside the memory directory", () => {
    expect(resolveMemoryEditTarget(memoryDir, projectFile, "../config.json")).toBeNull();
  });

  it("rejects sibling-prefix escapes", () => {
    expect(resolveMemoryEditTarget(memoryDir, projectFile, "../memory2/project.md")).toBeNull();
  });
});

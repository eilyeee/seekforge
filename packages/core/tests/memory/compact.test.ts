import { describe, expect, it } from "vitest";
import { compactProjectMemory } from "../../src/memory/index.js";
import { makeWorkspace, readProjectMd, writeProjectMemory } from "./helpers.js";

describe("compactProjectMemory", () => {
  it("collapses exact-duplicate bullets, preserving the header and order", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [command] use pnpm to install",
        "- [path] src/index.ts is the entrypoint",
        "- [command] use pnpm to install",
        "",
      ].join("\n"),
    );

    const res = compactProjectMemory(ws);
    expect(res.before).toBe(3);
    expect(res.after).toBe(2);
    expect(res.removed).toEqual(["- [command] use pnpm to install"]);

    const md = readProjectMd(ws);
    expect(md.startsWith("# Project Memory")).toBe(true);
    // First occurrence kept in place, duplicate removed.
    expect(md.match(/use pnpm to install/g)).toHaveLength(1);
    expect(md).toContain("- [path] src/index.ts is the entrypoint");
    // Order preserved: command before path.
    expect(md.indexOf("use pnpm")).toBeLessThan(md.indexOf("src/index.ts"));
  });

  it("merges near-duplicates of the same type, keeping the longer bullet", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [convention] run the full test suite before commit",
        "- [convention] run the full test suite before commit always",
        "",
      ].join("\n"),
    );

    // Word sets: {run,the,full,test,suite,before,commit} vs the same + {always}.
    // Jaccard = 7/8 = 0.875 >= 0.8 → near-duplicate, keep the longer.
    const res = compactProjectMemory(ws);
    expect(res.before).toBe(2);
    expect(res.after).toBe(1);
    expect(res.removed).toEqual([]);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0]?.kept).toContain("always");
    expect(res.merged[0]?.dropped).toBe("- [convention] run the full test suite before commit");

    const md = readProjectMd(ws);
    // The longer survivor sits in the earlier (first) slot.
    expect(md).toContain("run the full test suite before commit always");
    expect(md.match(/test suite/g)).toHaveLength(1);
  });

  it("merges near-duplicate Chinese facts via per-character tokenization", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [convention] 项目使用 pnpm 作为包管理器",
        "- [convention] 项目使用 pnpm 包管理器",
        "",
      ].join("\n"),
    );
    // Without per-char CJK tokenization each clause is one token and these
    // never overlap; with it the shared characters push Jaccard past 0.8.
    const res = compactProjectMemory(ws);
    expect(res.after).toBe(1);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0]?.kept).toContain("作为包管理器"); // the longer survives
  });

  it("does NOT merge near-duplicates across different types", () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [command] run the test suite",
        "- [convention] run the test suite",
        "",
      ].join("\n"),
    );
    const res = compactProjectMemory(ws);
    expect(res.after).toBe(2);
    expect(res.merged).toEqual([]);
  });

  it("leaves unrelated facts untouched", () => {
    const ws = makeWorkspace();
    const original = [
      "# Project Memory",
      "- [command] use pnpm",
      "- [path] src/cli.ts hosts the commander setup",
      "- [tech] DeepSeek is the model provider",
      "",
    ].join("\n");
    writeProjectMemory(ws, original);

    const res = compactProjectMemory(ws);
    expect(res.before).toBe(3);
    expect(res.after).toBe(3);
    expect(res.removed).toEqual([]);
    expect(res.merged).toEqual([]);
    expect(readProjectMd(ws)).toBe(original);
  });

  it("dry-run reports the plan without rewriting project.md", () => {
    const ws = makeWorkspace();
    const original = [
      "# Project Memory",
      "- [command] use pnpm to install",
      "- [command] use pnpm to install",
      "",
    ].join("\n");
    writeProjectMemory(ws, original);

    const res = compactProjectMemory(ws, { dryRun: true });
    expect(res.before).toBe(2);
    expect(res.after).toBe(1);
    expect(res.removed).toHaveLength(1);
    // File untouched.
    expect(readProjectMd(ws)).toBe(original);
  });

  it("returns zeros when project.md does not exist", () => {
    const ws = makeWorkspace();
    const res = compactProjectMemory(ws);
    expect(res).toEqual({ before: 0, after: 0, removed: [], merged: [], archived: [] });
  });
});

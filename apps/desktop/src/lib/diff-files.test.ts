import { describe, expect, it } from "vitest";
import { diffTotals, filterToPaths, splitDiffByFile, splitFileHunks } from "./diff-files";

const TWO_FILES = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old line",
  "+new line",
  " context",
  "diff --git a/b.md b/b.md",
  "--- a/b.md",
  "+++ b/b.md",
  "@@ -1 +1,2 @@",
  " keep",
  "+added one",
  "+added two",
].join("\n");

describe("splitDiffByFile", () => {
  it("splits per file with correct stats", () => {
    const files = splitDiffByFile(TWO_FILES);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.md"]);
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(files[1]).toMatchObject({ additions: 2, deletions: 0 });
    // header markers (+++/---) are not counted as changes
    expect(files[0]!.text).toContain("diff --git a/a.ts");
  });

  it("returns no files for an empty diff", () => {
    expect(splitDiffByFile("")).toEqual([]);
    expect(splitDiffByFile("\n")).toEqual([]);
  });

  it("handles git-quoted paths (spaces and non-ASCII filenames)", () => {
    const quoted = [
      'diff --git "a/my file.ts" "b/my file.ts"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      // 设.md → git octal-escapes UTF-8 bytes: 设 = \350\256\276
      'diff --git "a/\\350\\256\\276.md" "b/\\350\\256\\276.md"',
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");
    const files = splitDiffByFile(quoted);
    expect(files.map((f) => f.path)).toEqual(["my file.ts", "设.md"]);
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(files[1]).toMatchObject({ additions: 1, deletions: 0 });
  });

  it("totals add up", () => {
    expect(diffTotals(splitDiffByFile(TWO_FILES))).toEqual({ files: 2, additions: 3, deletions: 1 });
  });
});

describe("splitFileHunks", () => {
  it("splits a file diff at its hunks, keeping each hunk's exact text", () => {
    const [file] = splitDiffByFile(`${TWO_FILES.split("diff --git a/b.md")[0]!.trimEnd()}\n@@ -9 +9 @@\n-x\n+y\n`);
    const split = splitFileHunks(file!.text);
    expect(split.header).toBe("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts");
    expect(split.hunks).toEqual(["@@ -1,2 +1,2 @@\n-old line\n+new line\n context", "@@ -9 +9 @@\n-x\n+y"]);
    expect(split.actionable).toBe(true);
  });

  it("marks binary and renamed files as whole-file only", () => {
    expect(splitFileHunks("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ").actionable).toBe(
      false,
    );
    expect(
      splitFileHunks(
        "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n@@ -1 +1 @@\n-a\n+b",
      ).actionable,
    ).toBe(false);
  });
});

describe("filterToPaths", () => {
  it("keeps only the listed paths, or everything without a filter", () => {
    const files = [{ path: "a.ts" }, { path: "b.ts" }];
    expect(filterToPaths(files, new Set(["b.ts"]))).toEqual([{ path: "b.ts" }]);
    expect(filterToPaths(files, null)).toBe(files);
  });
});

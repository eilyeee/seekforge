import { describe, expect, it } from "vitest";
import { diffTotals, splitDiffByFile } from "./diff-files";

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

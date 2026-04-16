import { describe, expect, it } from "vitest";
import { computeDiffLines } from "../diff.js";

describe("computeDiffLines", () => {
  it("returns [] for identical inputs", () => {
    expect(computeDiffLines("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
    expect(computeDiffLines(null, null)).toEqual([]);
    expect(computeDiffLines("", "")).toEqual([]);
  });

  it("emits one hunk with correct header numbers for a single-line change", () => {
    const lines = computeDiffLines("a\nb\nc\n", "a\nx\nc\n");
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "ctx", text: " a" },
      { kind: "del", text: "-b" },
      { kind: "add", text: "+x" },
      { kind: "ctx", text: " c" },
    ]);
  });

  it("joins adjacent hunks whose context regions overlap", () => {
    // Changes at lines 3 and 8 with default context 2: gap of 4 equal lines
    // (4..7 minus the changed 8) — padded ranges touch, so one hunk.
    const before = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n");
    const after = ["l1", "l2", "X3", "l4", "l5", "l6", "l7", "X8", "l9", "l10"].join("\n");
    const lines = computeDiffLines(before, after);
    const hunks = lines.filter((l) => l.kind === "hunk");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.text).toBe("@@ -1,10 +1,10 @@");
  });

  it("emits separate hunks when changes are far apart", () => {
    const mid = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const before = ["a", ...mid, "z"].join("\n");
    const after = ["A", ...mid, "Z"].join("\n");
    const lines = computeDiffLines(before, after);
    const hunks = lines.filter((l) => l.kind === "hunk");
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.text).toBe("@@ -1,3 +1,3 @@");
    expect(hunks[1]?.text).toBe("@@ -20,3 +20,3 @@");
  });

  it("renders creation (null before) as all adds with a -0,0 header", () => {
    expect(computeDiffLines(null, "a\nb\n")).toEqual([
      { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
      { kind: "add", text: "+a" },
      { kind: "add", text: "+b" },
    ]);
  });

  it("renders deletion (null after) as all dels with a +0,0 header", () => {
    expect(computeDiffLines("a\nb\n", null)).toEqual([
      { kind: "hunk", text: "@@ -1,2 +0,0 @@" },
      { kind: "del", text: "-a" },
      { kind: "del", text: "-b" },
    ]);
  });

  it("skips the DP and truncates when a side exceeds 2000 lines", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const lines = computeDiffLines(big, "x\n");
    expect(lines[0]).toEqual({ kind: "hunk", text: "@@ -1,2500 +1,1 @@" });
    expect(lines[lines.length - 1]).toEqual({ kind: "hunk", text: "@@ … truncated @@" });
    expect(lines.filter((l) => l.kind === "del")).toHaveLength(200);
    expect(lines.filter((l) => l.kind === "add")).toHaveLength(1);
  });
});

describe("classifyUnifiedDiff", () => {
  it("classifies git diff output lines", async () => {
    const { classifyUnifiedDiff } = await import("../diff.js");
    const text = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      " ctx line",
      "-old",
      "+new",
      "",
    ].join("\n");
    const kinds = classifyUnifiedDiff(text).map((l) => l.kind);
    expect(kinds).toEqual(["hunk", "hunk", "hunk", "hunk", "hunk", "ctx", "del", "add"]);
  });
});

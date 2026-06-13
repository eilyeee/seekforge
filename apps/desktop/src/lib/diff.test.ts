import { describe, expect, it } from "vitest";
import { classifyDiffLine, diffFilePath, extractDiff, splitDiff } from "./diff";

describe("classifyDiffLine", () => {
  it("classifies additions and deletions", () => {
    expect(classifyDiffLine("+added line")).toBe("add");
    expect(classifyDiffLine("-removed line")).toBe("del");
  });

  it("treats file headers as meta, not add/del", () => {
    expect(classifyDiffLine("+++ b/src/index.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/src/index.ts")).toBe("meta");
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("index 1234567..89abcde 100644")).toBe("meta");
    expect(classifyDiffLine("new file mode 100644")).toBe("meta");
  });

  it("classifies hunk headers and context", () => {
    expect(classifyDiffLine("@@ -1,3 +1,4 @@ fn main")).toBe("hunk");
    expect(classifyDiffLine(" unchanged")).toBe("ctx");
    expect(classifyDiffLine("plain text")).toBe("ctx");
  });
});

describe("splitDiff", () => {
  it("splits and classifies, dropping the trailing newline artifact", () => {
    const lines = splitDiff("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n");
    expect(lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add"]);
    expect(lines[4]).toEqual({ kind: "add", text: "+new" });
  });
});

describe("diffFilePath", () => {
  it("prefers the +++ b/<path> line and strips the a/b prefix", () => {
    const diff = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+x";
    expect(diffFilePath(diff)).toBe("src/x.ts");
  });

  it("falls back to --- or diff --git when no +++ path is present", () => {
    expect(diffFilePath("--- a/lib/foo.py\n@@")).toBe("lib/foo.py");
    expect(diffFilePath("diff --git a/cmd/main.go b/cmd/main.go")).toBe("cmd/main.go");
  });

  it("ignores /dev/null (new/deleted files) and returns '' when no path", () => {
    expect(diffFilePath("+++ /dev/null\n--- a/gone.rs")).toBe("gone.rs");
    expect(diffFilePath("@@ -1 +1 @@\n-a\n+b")).toBe("");
  });
});

describe("extractDiff", () => {
  it("returns the diff string from tool result data", () => {
    expect(extractDiff({ diff: "+x" })).toBe("+x");
  });

  it("rejects non-string, empty, or absent diff fields", () => {
    expect(extractDiff({ diff: 42 })).toBeNull();
    expect(extractDiff({ diff: "" })).toBeNull();
    expect(extractDiff({ output: "hi" })).toBeNull();
    expect(extractDiff(null)).toBeNull();
    expect(extractDiff("string")).toBeNull();
  });
});

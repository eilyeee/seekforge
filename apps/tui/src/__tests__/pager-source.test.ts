import { describe, expect, it } from "vitest";
import type { ChatItem } from "../model.js";
import { pagerLines, pagerWindow } from "../pager-source.js";

const ITEMS: ChatItem[] = [
  { kind: "user", id: "u1", text: "fix the bug\nin the parser" },
  {
    kind: "thinking",
    id: "th1",
    text: "the parser drops the last token",
    streaming: false,
    startedAt: 0,
    endedAt: 1,
  },
  { kind: "step", id: "s1", title: "read_file", agentId: "sub-1" },
  {
    kind: "tool",
    id: "t1",
    toolName: "read_file",
    args: { path: "src/parse.ts" },
    status: "ok",
    resultPreview: '{\n "lines": 42\n}',
  },
  {
    kind: "tool",
    id: "t2",
    toolName: "run_command",
    args: {},
    status: "error",
    error: { code: "exit_1", message: "tests failed" },
  },
  { kind: "assistant", id: "a1", text: "Found it — off-by-one in the loop.", streaming: false },
  {
    kind: "diff",
    id: "d1",
    path: "src/parse.ts",
    lines: [
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "del", text: "-let i = 1;" },
      { kind: "add", text: "+let i = 0;" },
      { kind: "ctx", text: " return i;" },
    ],
  },
  { kind: "shell", id: "sh1", command: "pnpm test", output: "42 passed\n", exitCode: 0 },
  {
    kind: "plan",
    id: "p1",
    items: [
      { step: "reproduce", status: "done" },
      { step: "fix", status: "in_progress" },
    ],
  },
  { kind: "file", id: "f1", path: "src/parse.ts" },
  { kind: "notice", id: "n1", text: "context compacted", tone: "dim" },
  {
    kind: "report",
    id: "r1",
    report: {
      summary: "Fixed the off-by-one.",
      changedFiles: ["src/parse.ts"],
      commandsRun: ["pnpm test"],
      verification: "tests pass",
      usage: { promptTokens: 1, completionTokens: 2, cacheHitTokens: 0, costUsd: 0 },
    },
  },
];

describe("pagerLines", () => {
  const lines = pagerLines(ITEMS);
  const text = lines.join("\n");

  it("includes user (multiline) and assistant content", () => {
    expect(lines).toContain("❯ fix the bug");
    expect(lines).toContain("  in the parser"); // continuation lines indented
    expect(lines).toContain("Found it — off-by-one in the loop.");
  });

  it("expands thinking blocks", () => {
    expect(lines).toContain("✳ thinking");
    expect(lines).toContain("  the parser drops the last token");
  });

  it("expands tool rows fully, including result previews and errors", () => {
    expect(lines).toContain("✓ read_file");
    expect(lines).toContain('   "lines": 42'); // resultPreview: "  " prefix + ' "lines": 42'
    expect(lines).toContain("✗ run_command — exit_1: tests failed");
    expect(lines).toContain("→ [sub-1] read_file");
  });

  it("includes every diff line with its markers", () => {
    expect(lines).toContain("Diff: src/parse.ts");
    expect(lines).toContain("@@ -1,2 +1,2 @@");
    expect(lines).toContain("-let i = 1;");
    expect(lines).toContain("+let i = 0;");
    expect(lines).toContain(" return i;");
  });

  it("includes shell, plan, file, notice, and report items", () => {
    expect(lines).toContain("$ pnpm test (exit 0)");
    expect(lines).toContain("  42 passed");
    expect(lines).toContain("  [x] reproduce");
    expect(lines).toContain("  [ ] fix ←");
    expect(lines).toContain("● changed src/parse.ts");
    expect(lines).toContain("· context compacted");
    expect(lines).toContain("Fixed the off-by-one.");
    expect(lines).toContain("  ● src/parse.ts");
    expect(lines).toContain("Verification: tests pass");
  });

  it("produces no ANSI escapes and no leading/trailing blanks", () => {
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[/);
    expect(lines[0]).not.toBe("");
    expect(lines[lines.length - 1]).not.toBe("");
  });

  it("returns [] for an empty transcript", () => {
    expect(pagerLines([])).toEqual([]);
  });
});

describe("pagerWindow", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);

  it("anchors to the top at offset 0", () => {
    expect(pagerWindow(lines, 0, 4)).toEqual({ start: 0, end: 4, hiddenAbove: 0, hiddenBelow: 6 });
  });

  it("scrolls down by the offset", () => {
    expect(pagerWindow(lines, 3, 4)).toEqual({ start: 3, end: 7, hiddenAbove: 3, hiddenBelow: 3 });
  });

  it("clamps an over-large offset so the last page stays full", () => {
    expect(pagerWindow(lines, 99, 4)).toEqual({ start: 6, end: 10, hiddenAbove: 6, hiddenBelow: 0 });
  });

  it("clamps a negative offset to the top and shows everything when it fits", () => {
    expect(pagerWindow(lines, -5, 4)).toEqual({ start: 0, end: 4, hiddenAbove: 0, hiddenBelow: 6 });
    expect(pagerWindow(lines.slice(0, 3), 5, 10)).toEqual({
      start: 0,
      end: 3,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });
});

import { describe, expect, it } from "vitest";
import { auditExportPath, defaultExportPath, transcriptToMarkdown } from "../export.js";
import type { ChatItem } from "../model.js";

describe("transcriptToMarkdown", () => {
  it("serializes every item kind into readable markdown", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "fix the bug" },
      { kind: "step", id: "s1", title: "turn 1" },
      { kind: "step", id: "s2", title: "read_file", agentId: "explorer" },
      { kind: "tool", id: "t1", toolName: "read_file", args: {}, status: "ok" },
      { kind: "tool", id: "t2", toolName: "run_command", args: {}, status: "error", error: { code: "E", message: "boom" } },
      { kind: "assistant", id: "a1", text: "Here is the fix.", streaming: false },
      { kind: "plan", id: "p1", items: [{ step: "a", status: "done" }, { step: "b", status: "in_progress" }] },
      { kind: "file", id: "f1", path: "src/x.ts" },
      { kind: "diff", id: "d1", path: "src/x.ts", lines: [{ kind: "add", text: "+new" }] },
      { kind: "shell", id: "sh1", command: "ls", output: "a.txt", exitCode: 0 },
      { kind: "notice", id: "n1", text: "fyi", tone: "dim" },
      {
        kind: "report",
        id: "r1",
        report: {
          summary: "done",
          changedFiles: ["src/x.ts"],
          commandsRun: [],
          verification: "tests pass",
          usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0 },
        },
      },
    ];
    const md = transcriptToMarkdown(items, { title: "T" });
    expect(md.startsWith("# T\n")).toBe(true);
    expect(md).toContain("## ❯ fix the bug");
    expect(md).toContain("> ↳ [explorer] read_file");
    expect(md).toContain("- ✓ `read_file`");
    expect(md).toContain("- ✗ `run_command` — E: boom");
    expect(md).toContain("- [x] a");
    expect(md).toContain("- [ ] b ←");
    expect(md).toContain("```diff\n+new\n```");
    expect(md).toContain("**$ ls** (exit 0)");
    expect(md).toContain("Verification: tests pass");
    expect(md.endsWith("\n")).toBe(true);
    expect(md).not.toMatch(/\n{3,}/);
  });

  it("defaultExportPath is timestamped under .seekforge/exports", () => {
    const p = defaultExportPath(new Date("2026-06-12T10:00:00Z"));
    expect(p).toBe(".seekforge/exports/tui-20260612T100000.md");
  });

  it("auditExportPath embeds the session id and timestamp under .seekforge/exports", () => {
    const p = auditExportPath("sess-abc", new Date("2026-06-12T10:00:00Z"));
    expect(p).toBe(".seekforge/exports/audit-sess-abc-20260612T100000.md");
  });
});

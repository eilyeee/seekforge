import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHandoff, HANDOFF_CAPS, handoffPath, latestHandoff, listHandoffs } from "../handoff.js";
import type { ChatItem } from "../model.js";

const tool = (id: string, toolName: string, args: unknown): ChatItem => ({
  kind: "tool",
  id,
  toolName,
  args,
  status: "ok",
});

describe("buildHandoff", () => {
  it("renders header and all sections from fixture items", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "fix the login bug" },
      tool("t1", "read_file", { path: "src/auth.ts" }),
      { kind: "file", id: "f1", path: "src/auth.ts" },
      { kind: "diff", id: "d1", path: "src/auth.ts", lines: [{ kind: "add", text: "+x" }] }, // dup of f1
      { kind: "diff", id: "d2", path: "src/session.ts", lines: [] },
      tool("t2", "run_command", { command: "pnpm test" }),
      tool("t3", "run_command", { command: "pnpm test" }), // dup command
      tool("t4", "write_file", { path: "ignored.ts" }), // not a run_command
      { kind: "user", id: "u2", text: "also add a test" },
      {
        kind: "assistant",
        id: "a1",
        text: "Fixed and tested. Remaining:\n- should expired tokens redirect?\n- is /logout in scope?",
        streaming: false,
      },
    ];
    const md = buildHandoff({ items, sessionId: "s-123", model: "deepseek-v4-pro", costUsd: 0.1234 });

    expect(md.startsWith("# Session handoff\n")).toBe(true);
    expect(md).toContain("- Model: deepseek-v4-pro");
    expect(md).toContain("- Session: s-123");
    expect(md).toContain("- Cost: $0.1234");
    // Tasks: every user item, in order.
    expect(md).toContain("## Tasks\n\n- fix the login bug\n- also add a test");
    // Files: file+diff deduped, first-seen order.
    expect(md).toContain("## Files touched\n\n- `src/auth.ts`\n- `src/session.ts`");
    // Commands: run_command only, deduped.
    expect(md).toContain("## Commands run\n\n- `pnpm test`\n");
    expect(md).not.toContain("ignored.ts");
    // Open questions from the trailing bullet list of the last assistant item.
    expect(md).toContain("## Open questions\n\n- should expired tokens redirect?\n- is /logout in scope?");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("uses a placeholder when the last assistant item has no trailing bullets", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "assistant", id: "a1", text: "All done, nothing pending.", streaming: false },
    ];
    const md = buildHandoff({ items, model: "m", costUsd: 0 });
    expect(md).toContain("## Open questions\n\n- (none");
    expect(md).not.toContain("- Session:"); // sessionId omitted when absent
  });

  it("an all-bullet assistant message is a list answer, not open questions", () => {
    const items: ChatItem[] = [{ kind: "assistant", id: "a1", text: "- alpha\n- beta", streaming: false }];
    const md = buildHandoff({ items, model: "m", costUsd: 0 });
    expect(md).toContain("## Open questions\n\n- (none");
  });

  it("caps each section keeping the most recent entries", () => {
    const items: ChatItem[] = [];
    for (let i = 0; i < HANDOFF_CAPS.tasks + 3; i++) {
      items.push({ kind: "user", id: `u${i}`, text: `task ${i}` });
    }
    for (let i = 0; i < HANDOFF_CAPS.commands + 2; i++) {
      items.push(tool(`t${i}`, "run_command", { command: `cmd ${i}` }));
    }
    const md = buildHandoff({ items, model: "m", costUsd: 0 });
    expect(md).toContain("- … 3 earlier omitted\n- task 3");
    expect(md).not.toContain("- task 2\n");
    expect(md).toContain(`- task ${HANDOFF_CAPS.tasks + 2}`);
    expect(md).toContain("- … 2 earlier omitted");
    expect(md).toContain(`- \`cmd ${HANDOFF_CAPS.commands + 1}\``);
    expect(md).not.toContain("- `cmd 1`");
  });

  it("handoffPath is timestamped under .seekforge/handoffs", () => {
    const p = handoffPath(new Date("2026-06-12T10:00:00Z"));
    expect(p).toBe(".seekforge/handoffs/handoff-20260612T100000.md");
  });
});

describe("listHandoffs / latestHandoff", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-handoff-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns [] / null when the directory does not exist", () => {
    expect(listHandoffs(workspace)).toEqual([]);
    expect(latestHandoff(workspace)).toBeNull();
  });

  it("lists newest first and previews the first 10 lines of the latest", () => {
    const dir = join(workspace, ".seekforge", "handoffs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "handoff-20260101T000000.md"), "# old\n");
    const body = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "handoff-20260612T100000.md"), body);
    writeFileSync(join(dir, "notes.txt"), "ignored");

    const list = listHandoffs(workspace);
    expect(list).toEqual([join(dir, "handoff-20260612T100000.md"), join(dir, "handoff-20260101T000000.md")]);

    const preview = latestHandoff(workspace);
    expect(preview!.split("\n")).toHaveLength(10);
    expect(preview).toContain("line 1");
    expect(preview).toContain("line 10");
    expect(preview).not.toContain("line 11");
  });

  it("does not read an oversized handoff preview", () => {
    const dir = join(workspace, ".seekforge", "handoffs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "handoff-20260721T120000.md");
    writeFileSync(file, "x".repeat(64 * 1024 + 1));
    expect(latestHandoff(workspace)).toBeNull();
  });
});

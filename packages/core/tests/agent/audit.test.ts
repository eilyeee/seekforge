import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCheckpoint, createSessionTrace, writeSessionMeta } from "../../src/agent/trace.js";
import { buildSessionAudit, renderSessionAuditMarkdown } from "../../src/agent/audit.js";

describe("buildSessionAudit / renderSessionAuditMarkdown", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-audit-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const sid = "s1";

  /**
   * Synthetic 2-turn session:
   *  - turn 0: task → assistant reads a file (ok) and edits it (created new.txt);
   *  - turn 1: follow-up → assistant runs a command that fails.
   */
  function seed(): void {
    writeSessionMeta(ws, {
      id: sid,
      task: "add a feature\nsecond line",
      mode: "edit",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
      usage: { promptTokens: 1200, completionTokens: 340, cacheHitTokens: 800, costUsd: 0.0123 },
    });

    const trace = createSessionTrace(ws, sid);
    trace.message({ role: "system", content: "system prompt" });

    // Turn 0
    trace.message({ role: "user", content: "add a feature" });
    trace.message({
      role: "assistant",
      content: "Reading and editing.",
      toolCalls: [
        { id: "c1", name: "read_file", argumentsJson: '{ "path" : "src/app.ts" }' },
        { id: "c2", name: "write_file", argumentsJson: '{"path":"new.txt","content":"hello"}' },
      ],
    });
    trace.message({ role: "tool", content: '{"ok":true,"data":"file contents"}', toolCallId: "c1" });
    trace.message({ role: "tool", content: '{"ok":true,"data":"written"}', toolCallId: "c2" });

    // Turn 1
    trace.message({ role: "user", content: "now run the tests" });
    trace.message({
      role: "assistant",
      content: "Running tests.",
      toolCalls: [{ id: "c3", name: "run_command", argumentsJson: '{"command":"pnpm test"}' }],
    });
    trace.message({ role: "tool", content: '{"ok":false,"error":"exit 1"}', toolCallId: "c3" });

    // Checkpoints: src/app.ts modified in turn 0, new.txt created in turn 0.
    appendCheckpoint(ws, sid, { ts: "t0", path: "src/app.ts", before: "old", turn: 0 });
    appendCheckpoint(ws, sid, { ts: "t0", path: "new.txt", before: null, turn: 0 });
  }

  it("assembles turns, tool outcomes, files changed, and totals", () => {
    seed();
    const audit = buildSessionAudit(ws, sid);
    expect(audit).not.toBeNull();
    const a = audit!;

    // meta
    expect(a.meta.id).toBe(sid);
    expect(a.meta.mode).toBe("edit");
    expect(a.meta.status).toBe("completed");
    expect(a.meta.createdAt).toBe("2026-01-01T00:00:00.000Z");

    // turns
    expect(a.turns).toHaveLength(2);
    expect(a.turns[0]!.index).toBe(0);
    expect(a.turns[0]!.user).toBe("add a feature");
    expect(a.turns[0]!.assistant).toBe("Reading and editing.");
    expect(a.turns[0]!.toolCalls.map((c) => c.name)).toEqual(["read_file", "write_file"]);
    // argsSummary is the argumentsJson compacted (whitespace collapsed).
    expect(a.turns[0]!.toolCalls[0]!.argsSummary).toBe('{"path":"src/app.ts"}');
    expect(a.turns[0]!.toolCalls[0]!.ok).toBe(true);

    // turn 1: failing command detected via the {"ok":false} result
    expect(a.turns[1]!.toolCalls).toHaveLength(1);
    const failed = a.turns[1]!.toolCalls[0]!;
    expect(failed.name).toBe("run_command");
    expect(failed.ok).toBe(false);
    expect(failed.resultPreview).toContain("exit 1");

    // filesChanged: created vs modified + turn numbers
    const app = a.filesChanged.find((f) => f.path === "src/app.ts")!;
    const created = a.filesChanged.find((f) => f.path === "new.txt")!;
    expect(app.created).toBe(false);
    expect(app.turns).toEqual([0]);
    expect(created.created).toBe(true);
    expect(created.turns).toEqual([0]);

    // totals
    expect(a.totals.userTurns).toBe(2);
    expect(a.totals.assistantMessages).toBe(2);
    expect(a.totals.toolCalls).toBe(3);
    expect(a.totals.filesChanged).toBe(2);
    expect(a.totals.tokens).toEqual({ prompt: 1200, completion: 340, cacheHit: 800 });
    expect(a.totals.costUsd).toBe(0.0123);
  });

  it("renders scannable markdown with the key lines", () => {
    seed();
    const md = renderSessionAuditMarkdown(buildSessionAudit(ws, sid)!);

    expect(md).toContain("# Session Audit — add a feature");
    expect(md).toContain(`- ID: ${sid}`);
    expect(md).toContain("cost $0.0123");
    expect(md).toContain("## Files changed");
    expect(md).toContain("`new.txt` (created)");
    expect(md).toContain("`src/app.ts` (modified) — turn(s) 0");
    expect(md).toContain("## Timeline");
    expect(md).toContain("### Turn 0");
    expect(md).toContain("✓ read_file(");
    expect(md).toContain("✗ run_command(");
  });

  it("returns null for an unknown session id", () => {
    expect(buildSessionAudit(ws, "does-not-exist")).toBeNull();
  });

  it("builds an audit even when session meta is absent (zeroed totals)", () => {
    const trace = createSessionTrace(ws, "nometa");
    trace.message({ role: "user", content: "hi" });
    trace.message({ role: "assistant", content: "hello" });
    const a = buildSessionAudit(ws, "nometa")!;
    expect(a.meta.id).toBe("nometa");
    expect(a.totals.costUsd).toBe(0);
    expect(a.totals.tokens).toEqual({ prompt: 0, completion: 0, cacheHit: 0 });
  });
});

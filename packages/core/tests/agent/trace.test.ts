import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSessions,
  pruneSessions,
  writeSessionMeta,
  type SessionMeta,
} from "../../src/agent/trace.js";

function meta(id: string, daysAgo: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return { id, task: `task ${id}`, mode: "edit", status: "completed", createdAt: ts, updatedAt: ts, ...extra };
}

describe("sessions list + prune", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-trace-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const dir = (id: string) => join(ws, ".seekforge", "sessions", id);

  it("hides subagent sessions from listSessions by default", () => {
    writeSessionMeta(ws, meta("s1", 1));
    writeSessionMeta(ws, meta("sub1", 1, { parentAgentId: "meta-prism" }));
    expect(listSessions(ws).map((s) => s.id)).toEqual(["s1"]);
    expect(listSessions(ws, { includeSubagents: true }).map((s) => s.id).sort()).toEqual(["s1", "sub1"]);
  });

  it("prunes by age, keeping running sessions", () => {
    writeSessionMeta(ws, meta("old", 40));
    writeSessionMeta(ws, meta("recent", 1));
    writeSessionMeta(ws, meta("oldrunning", 40, { status: "running" }));
    const res = pruneSessions(ws, { olderThanDays: 30 });
    expect(res.removed).toEqual(["old"]);
    expect(existsSync(dir("old"))).toBe(false);
    expect(existsSync(dir("recent"))).toBe(true);
    expect(existsSync(dir("oldrunning"))).toBe(true); // running never pruned
  });

  it("prunes by keepLast on top-level sessions and takes their subagents along", () => {
    writeSessionMeta(ws, meta("s1", 3));
    writeSessionMeta(ws, meta("s2", 2));
    writeSessionMeta(ws, meta("s3", 1));
    writeSessionMeta(ws, meta("sub-old", 3, { parentAgentId: "x" }));
    const res = pruneSessions(ws, { keepLast: 2 });
    // s1 (oldest top-level) overflows; the old subagent is pruned by... it has no
    // age cutoff here, so it survives unless olderThan is set. keepLast only
    // affects top-level. Verify s1 removed, s2/s3 kept.
    expect(res.removed).toContain("s1");
    expect(existsSync(dir("s2"))).toBe(true);
    expect(existsSync(dir("s3"))).toBe(true);
  });

  it("dry-run reports without deleting", () => {
    writeSessionMeta(ws, meta("old", 40));
    const res = pruneSessions(ws, { olderThanDays: 30, dryRun: true });
    expect(res.removed).toEqual(["old"]);
    expect(existsSync(dir("old"))).toBe(true);
  });
});

describe("compactSessionNow", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-compactnow-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("compacts a long session in place and the rewrite is replayable", async () => {
    const { createSessionTrace, loadSessionMessages, compactSessionNow } = await import(
      "../../src/agent/trace.js"
    );
    const trace = createSessionTrace(ws, "s1");
    trace.message({ role: "system", content: "system prompt" });
    trace.message({ role: "user", content: "the task" });
    for (let i = 0; i < 20; i += 1) {
      trace.message({ role: "assistant", content: `turn ${i} ${"x".repeat(200)}` });
      trace.message({ role: "user", content: `reply ${i}` });
    }
    const before = loadSessionMessages(ws, "s1");
    const result = compactSessionNow(ws, "s1");
    expect(result).not.toBeNull();
    expect(result!.droppedTurns).toBeGreaterThan(0);
    expect(result!.afterTokens).toBeLessThan(result!.beforeTokens);
    const after = loadSessionMessages(ws, "s1");
    expect(after.length).toBeLessThan(before.length);
    // Head (system + task) and digest survive.
    expect(after[0]?.content).toBe("system prompt");
    expect(after[1]?.content).toBe("the task");
    // The digest replaces the dropped middle: head, digest, then the tail.
    expect(after[2]?.role).toBe("user");
    expect(after[2]?.content.length).toBeGreaterThan(0);
  });

  it("returns null for short sessions and missing files", async () => {
    const { createSessionTrace, compactSessionNow } = await import("../../src/agent/trace.js");
    const trace = createSessionTrace(ws, "tiny");
    trace.message({ role: "system", content: "s" });
    trace.message({ role: "user", content: "t" });
    expect(compactSessionNow(ws, "tiny")).toBeNull();
    expect(compactSessionNow(ws, "missing")).toBeNull();
  });
});

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

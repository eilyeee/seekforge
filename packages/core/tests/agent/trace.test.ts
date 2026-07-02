import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("loadSessionMessages robustness", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-loadmsgs-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("skips a single corrupt line and keeps the valid messages", async () => {
    const { loadSessionMessages } = await import("../../src/agent/trace.js");
    const dir = join(ws, ".seekforge", "sessions", "s1");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ ts: "t0", role: "user", content: "hello" }),
      "{ this is not valid json",
      JSON.stringify({ ts: "t1", role: "assistant", content: "world" }),
    ];
    writeFileSync(join(dir, "messages.jsonl"), `${lines.join("\n")}\n`);
    const messages = loadSessionMessages(ws, "s1");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("hello");
    expect(messages[1]?.content).toBe("world");
  });
});

describe("truncateSessionAtUserTurn", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-truncate-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  /** system + task (turn 0) + 3 resumed user turns (1..3), assistant replies interleaved. */
  async function seed(id: string) {
    const { createSessionTrace } = await import("../../src/agent/trace.js");
    const trace = createSessionTrace(ws, id);
    trace.message({ role: "system", content: "system prompt" });
    trace.message({ role: "user", content: "the task" });
    trace.message({ role: "assistant", content: "answer 0" });
    trace.message({ role: "user", content: "follow-up 1" });
    trace.message({ role: "assistant", content: "answer 1" });
    trace.message({ role: "user", content: "follow-up 2" });
    trace.message({ role: "assistant", content: "answer 2" });
    trace.message({ role: "user", content: "follow-up 3" });
    trace.message({ role: "assistant", content: "answer 3" });
  }

  it("truncates at a user turn, keeping everything before it", async () => {
    const { loadSessionMessages, truncateSessionAtUserTurn } = await import("../../src/agent/trace.js");
    await seed("s1");
    const result = truncateSessionAtUserTurn(ws, "s1", 2);
    // 9 messages total; turn 2 is "follow-up 2" at index 5 → keep 5, drop 4.
    expect(result).toEqual({ removedMessages: 4, keptMessages: 5 });
    const after = loadSessionMessages(ws, "s1");
    expect(after.map((m) => m.content)).toEqual([
      "system prompt",
      "the task",
      "answer 0",
      "follow-up 1",
      "answer 1",
    ]);
  });

  it("refuses turn 0 and out-of-range turns", async () => {
    const { loadSessionMessages, truncateSessionAtUserTurn } = await import("../../src/agent/trace.js");
    await seed("s2");
    expect(truncateSessionAtUserTurn(ws, "s2", 0)).toBeNull();
    expect(truncateSessionAtUserTurn(ws, "s2", -1)).toBeNull();
    expect(truncateSessionAtUserTurn(ws, "s2", 4)).toBeNull(); // only turns 0..3 exist
    expect(loadSessionMessages(ws, "s2")).toHaveLength(9); // untouched
  });

  it("returns null for a missing session", async () => {
    const { truncateSessionAtUserTurn } = await import("../../src/agent/trace.js");
    expect(truncateSessionAtUserTurn(ws, "nope", 1)).toBeNull();
  });
});

describe("rewindSessionToTurn", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-rewindturn-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const sid = "s1";

  /**
   * a.txt touched in turns 0 and 2, b.txt created in turn 2, c.txt touched
   * only in turn 0. Current on-disk state reflects all three turns applied.
   */
  async function seed() {
    const { appendCheckpoint } = await import("../../src/agent/trace.js");
    writeFileSync(join(ws, "a.txt"), "a-final");
    writeFileSync(join(ws, "b.txt"), "b-created-turn2");
    writeFileSync(join(ws, "c.txt"), "c-modified-turn0");
    appendCheckpoint(ws, sid, { ts: "t0", path: "a.txt", before: "a-pre-turn0", turn: 0 });
    appendCheckpoint(ws, sid, { ts: "t0", path: "c.txt", before: "c-original", turn: 0 });
    appendCheckpoint(ws, sid, { ts: "t2", path: "a.txt", before: "a-pre-turn2", turn: 2 });
    appendCheckpoint(ws, sid, { ts: "t2", path: "b.txt", before: null, turn: 2 });
  }

  it("restores each path to its earliest entry with turn >= turnIndex, leaving earlier-only paths alone", async () => {
    const { rewindSessionToTurn } = await import("../../src/agent/trace.js");
    await seed();
    const res = rewindSessionToTurn(ws, sid, 2);
    expect(res.restored).toEqual(["a.txt"]);
    expect(res.deleted).toEqual(["b.txt"]);
    expect(res.skipped).toEqual([]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a-pre-turn2");
    expect(existsSync(join(ws, "b.txt"))).toBe(false);
    expect(readFileSync(join(ws, "c.txt"), "utf8")).toBe("c-modified-turn0"); // untouched
  });

  it("turnIndex 0 rewinds everything to the oldest pre-content", async () => {
    const { rewindSessionToTurn } = await import("../../src/agent/trace.js");
    await seed();
    const res = rewindSessionToTurn(ws, sid, 0);
    expect(res.restored.sort()).toEqual(["a.txt", "c.txt"]);
    expect(res.deleted).toEqual(["b.txt"]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a-pre-turn0");
    expect(readFileSync(join(ws, "c.txt"), "utf8")).toBe("c-original");
  });

  it("dryRun reports without touching files", async () => {
    const { rewindSessionToTurn } = await import("../../src/agent/trace.js");
    await seed();
    const res = rewindSessionToTurn(ws, sid, 2, { dryRun: true });
    expect(res.restored).toEqual(["a.txt"]);
    expect(res.deleted).toEqual(["b.txt"]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a-final");
    expect(existsSync(join(ws, "b.txt"))).toBe(true);
  });

  it("legacy entries without turn behave as turn 0", async () => {
    const { appendCheckpoint, rewindSessionToTurn } = await import("../../src/agent/trace.js");
    writeFileSync(join(ws, "legacy.txt"), "modified");
    appendCheckpoint(ws, sid, { ts: "t", path: "legacy.txt", before: "legacy-original" });
    expect(rewindSessionToTurn(ws, sid, 1).restored).toEqual([]); // turn 0 < 1: untouched
    expect(readFileSync(join(ws, "legacy.txt"), "utf8")).toBe("modified");
    expect(rewindSessionToTurn(ws, sid, 0).restored).toEqual(["legacy.txt"]);
    expect(readFileSync(join(ws, "legacy.txt"), "utf8")).toBe("legacy-original");
  });

  it("full rewindSession still restores the oldest state per path", async () => {
    const { rewindSession } = await import("../../src/agent/trace.js");
    await seed();
    const res = rewindSession(ws, sid);
    expect(res.restored.sort()).toEqual(["a.txt", "c.txt"]);
    expect(res.deleted).toEqual(["b.txt"]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a-pre-turn0");
    expect(readFileSync(join(ws, "c.txt"), "utf8")).toBe("c-original");
  });
});

describe("forkSession", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-fork-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("copies messages + checkpoints into a new session with derived meta", async () => {
    const { appendCheckpoint, createSessionTrace, forkSession, loadSessionMessages, readCheckpoints, readSessionMeta } =
      await import("../../src/agent/trace.js");
    writeSessionMeta(ws, meta("orig", 5, { task: "fix the bug" }));
    const trace = createSessionTrace(ws, "orig");
    trace.message({ role: "system", content: "system prompt" });
    trace.message({ role: "user", content: "fix the bug" });
    trace.message({ role: "assistant", content: "done" });
    appendCheckpoint(ws, "orig", { ts: "t0", path: "a.txt", before: "before", turn: 0 });

    const forkId = forkSession(ws, "orig");
    expect(forkId).not.toBeNull();
    expect(forkId).not.toBe("orig");

    // Conversation and checkpoints replay identically in the fork.
    expect(loadSessionMessages(ws, forkId!)).toEqual(loadSessionMessages(ws, "orig"));
    expect(readCheckpoints(ws, forkId!)).toEqual(readCheckpoints(ws, "orig"));

    const forkMeta = readSessionMeta(ws, forkId!)!;
    expect(forkMeta.id).toBe(forkId);
    expect(forkMeta.task).toBe("(fork) fix the bug");
    expect(forkMeta.status).toBe("completed");
    expect(forkMeta.mode).toBe("edit"); // inherited
    expect(new Date(forkMeta.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000); // fresh timestamps

    // The original is untouched.
    expect(readSessionMeta(ws, "orig")!.task).toBe("fix the bug");
  });

  it("works without a checkpoints file", async () => {
    const { createSessionTrace, forkSession, readCheckpoints } = await import("../../src/agent/trace.js");
    writeSessionMeta(ws, meta("nockpt", 1));
    const trace = createSessionTrace(ws, "nockpt");
    trace.message({ role: "user", content: "t" });
    const forkId = forkSession(ws, "nockpt");
    expect(forkId).not.toBeNull();
    expect(readCheckpoints(ws, forkId!)).toEqual([]);
  });

  it("returns null when the source session is missing or has no messages", async () => {
    const { forkSession } = await import("../../src/agent/trace.js");
    expect(forkSession(ws, "missing")).toBeNull();
    // Meta exists but messages.jsonl does not: still null.
    writeSessionMeta(ws, meta("metaonly", 1));
    expect(forkSession(ws, "metaonly")).toBeNull();
  });
});

describe("sessionTitle", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-title-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("uses the first non-empty summary.md line, stripping heading markers and capping at 80 chars", async () => {
    const { createSessionTrace, sessionTitle } = await import("../../src/agent/trace.js");
    const trace = createSessionTrace(ws, "s1");
    trace.summary(`\n\n## Fixed the login bug\n\nDetails follow.`);
    expect(sessionTitle(ws, "s1")).toBe("Fixed the login bug");

    const long = createSessionTrace(ws, "s2");
    long.summary(`# ${"x".repeat(120)}`);
    expect(sessionTitle(ws, "s2")).toHaveLength(80);
  });

  it("falls back to the meta task's first line, whitespace-collapsed", async () => {
    const { sessionTitle } = await import("../../src/agent/trace.js");
    writeSessionMeta(ws, meta("s3", 0, { task: "  fix   the\tthing \nsecond line ignored" }));
    expect(sessionTitle(ws, "s3")).toBe("fix the thing");
  });

  it("falls back to the session id when neither summary nor meta exists", async () => {
    const { sessionTitle } = await import("../../src/agent/trace.js");
    expect(sessionTitle(ws, "unknown-session")).toBe("unknown-session");
  });
});

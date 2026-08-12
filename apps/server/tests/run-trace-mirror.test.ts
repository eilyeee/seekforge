/**
 * An isolated run writes its JSONL trace inside the worktree it executes in,
 * while its ledger entry lives in the base checkout. Removing the worktree used
 * to take the audit trail with it and leave the base ledger pointing at a
 * session nothing in the base could open.
 *
 * The Loop half of the same route is covered in runs.test.ts, at the REST
 * surface where the isolation is decided.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSessionTrace,
  createWorktree,
  listSessions,
  readSessionMeta,
  removeWorktree,
  writeSessionMeta,
} from "@seekforge/core";
import { describe, expect, it, vi } from "vitest";
import { RunManager } from "../src/run-ledger.js";
import { beginRunSessionMirror } from "../src/run-trace-mirror.js";
import { startManagedTriggerRun } from "../src/trigger-run.js";
import { emptyReport, fakeAgentFactory, makeWorkspace } from "./helpers.js";

// Real `git worktree` I/O against tmp repos; under the full parallel run this
// can exceed vitest's 5s default (see worktrees.test.ts for the same note).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function makeGitRepo(): string {
  const repo = makeWorkspace();
  gitIn(repo, "init", "-b", "main");
  gitIn(repo, "config", "user.email", "test@seekforge.local");
  gitIn(repo, "config", "user.name", "SeekForge Test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  gitIn(repo, "commit", "--allow-empty", "-m", "initial");
  return repo;
}

function writeTrace(
  workspace: string,
  id: string,
  content: string,
  options: { parentAgentId?: string; createdAt?: string } = {},
): void {
  const now = options.createdAt ?? new Date().toISOString();
  writeSessionMeta(workspace, {
    id,
    task: content,
    mode: "ask",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    ...(options.parentAgentId ? { parentAgentId: options.parentAgentId } : {}),
  });
  createSessionTrace(workspace, id).message({ role: "user", content });
}

/** Writes the trace a real run would write into whatever workspace it runs in. */
function tracingAgent(sessionId: string, extraSessionId?: string) {
  return fakeAgentFactory(async function* (_opts, input) {
    const now = new Date().toISOString();
    for (const id of extraSessionId ? [sessionId, extraSessionId] : [sessionId]) {
      writeSessionMeta(input.projectPath, {
        id,
        task: input.task,
        mode: input.mode === "edit" ? "edit" : "ask",
        status: "running",
        createdAt: now,
        updatedAt: now,
        ...(id === extraSessionId ? { parentAgentId: "dispatch-1" } : {}),
      });
      const trace = createSessionTrace(input.projectPath, id);
      trace.message({ role: "user", content: `task for ${id}` });
      trace.toolCall({ name: "read_file", ok: true });
      trace.event({ type: "session.created", sessionId: id });
    }
    yield { type: "session.created", sessionId };
    for (const id of extraSessionId ? [sessionId, extraSessionId] : [sessionId]) {
      writeSessionMeta(input.projectPath, {
        id,
        task: input.task,
        mode: input.mode === "edit" ? "edit" : "ask",
        status: "completed",
        createdAt: now,
        updatedAt: new Date().toISOString(),
        ...(id === extraSessionId ? { parentAgentId: "dispatch-1" } : {}),
      });
    }
    yield { type: "session.completed", report: emptyReport() };
  });
}

describe("isolated trigger run trace", () => {
  it("lands in the base checkout and survives the worktree being discarded", async () => {
    const base = makeGitRepo();
    const worktree = await createWorktree(base, "trace-survives");
    const sessionId = "s-worktree-trace";

    const run = startManagedTriggerRun({
      createAgent: tracingAgent(sessionId, "s-worktree-subagent"),
      workspace: worktree.path,
      ledgerWorkspace: base,
      task: "audit the push",
      mode: "edit",
      maxCostUsd: 1,
    });
    await expect(run.started).resolves.toEqual({ sessionId });
    await run.completion;

    // The base checkout — where `seekforge sessions`/`replay`/`audit` look — can
    // see the run, including the session it dispatched.
    expect(listSessions(base).map((meta) => meta.id)).toEqual([sessionId]);
    expect(
      listSessions(base, { includeSubagents: true })
        .map((meta) => meta.id)
        .sort(),
    ).toEqual(["s-worktree-subagent", sessionId]);
    expect(readSessionMeta(base, sessionId)?.status).toBe("completed");
    expect(readFileSync(join(base, ".seekforge", "sessions", sessionId, "messages.jsonl"), "utf8")).toContain(
      `task for ${sessionId}`,
    );
    expect(readFileSync(join(base, ".seekforge", "sessions", sessionId, "tool-calls.jsonl"), "utf8")).toContain(
      "read_file",
    );

    // Discarding the worktree deletes its copy; the audit trail stays.
    await removeWorktree(base, worktree.path, worktree.branch);
    expect(existsSync(worktree.path)).toBe(false);
    expect(readSessionMeta(base, sessionId)?.status).toBe("completed");
    expect(readFileSync(join(base, ".seekforge", "sessions", sessionId, "messages.jsonl"), "utf8")).toContain(
      `task for ${sessionId}`,
    );
  });

  it("records the run ledger against a session the base checkout can open", async () => {
    const base = makeGitRepo();
    const worktree = await createWorktree(base, "trace-ledger");
    const runManager = new RunManager();
    const ledgerRun = runManager.create({ workspace: base, source: "trigger", labels: { isolation: "worktree" } });

    const run = startManagedTriggerRun({
      createAgent: tracingAgent("s-ledger-trace"),
      workspace: worktree.path,
      ledgerWorkspace: base,
      task: "audit the push",
      mode: "edit",
      maxCostUsd: 1,
      runManager,
      runId: ledgerRun.runId,
    });
    await run.started;
    await run.completion;

    const recorded = runManager.get(base, ledgerRun.runId);
    expect(recorded?.sessionId).toBe("s-ledger-trace");
    expect(readSessionMeta(base, recorded?.sessionId ?? "")).toBeDefined();
  });

  it("leaves a non-isolated run's trace alone", async () => {
    const workspace = makeWorkspace();
    const run = startManagedTriggerRun({
      createAgent: tracingAgent("s-in-place"),
      workspace,
      task: "t",
      mode: "ask",
      maxCostUsd: 1,
    });
    await run.started;
    await run.completion;
    expect(listSessions(workspace).map((meta) => meta.id)).toEqual(["s-in-place"]);
  });
});

describe("run session mirror", () => {
  it("carries no session that predates the run and no file outside the trace", () => {
    const from = makeWorkspace();
    const to = makeWorkspace();
    writeTrace(from, "s-before", "already here");

    const mirror = beginRunSessionMirror(from, to);
    writeTrace(from, "s-after", "written by the run");
    // Anything else the run wrote into its own session directory stays there:
    // the mirror copies known trace files by name, never a directory listing.
    writeFileSync(join(from, ".seekforge", "sessions", "s-after", "smuggled.md"), "x");

    expect(mirror.finish({ sessionId: "s-after" })).toEqual({ mirrored: ["s-after"], failures: [] });
    expect(existsSync(join(to, ".seekforge", "sessions", "s-before"))).toBe(false);
    expect(existsSync(join(to, ".seekforge", "sessions", "s-after", "messages.jsonl"))).toBe(true);
    expect(existsSync(join(to, ".seekforge", "sessions", "s-after", "smuggled.md"))).toBe(false);
  });

  /**
   * A recorded limit, not a guarantee. A fresh worktree has no `.seekforge/`, so
   * the before-snapshot is empty and any directory the run writes that parses as
   * a session is carried over — including one the agent loop never produced.
   * There is nothing unforgeable to filter on: `parentAgentId` is written by the
   * run, and the whole trace is authored by the agent process anyway, so a run
   * that wants to record something false can do it inside its own genuine
   * session. What must keep holding is that it cannot reach an id the base
   * already has, and cannot write a file outside the known trace names.
   */
  it("does not distinguish a fabricated session from a real one", () => {
    const from = makeWorkspace();
    const to = makeWorkspace();
    const mirror = beginRunSessionMirror(from, to);
    writeTrace(from, "s-real", "the run");
    writeTrace(from, "s-fabricated", "not produced by the agent loop");

    const result = mirror.finish({ sessionId: "s-real" });
    expect(result.mirrored.sort()).toEqual(["s-fabricated", "s-real"]);
    // The two properties that do hold, asserted here so a future tightening
    // cannot quietly drop them while "fixing" the one above.
    expect(existsSync(join(to, ".seekforge", "sessions", "s-fabricated", "session.json"))).toBe(true);
    expect(result.failures).toEqual([]);
  });

  /**
   * A run's edit tools reach anywhere in its own worktree, so it can create a
   * session directory named after one the base checkout already holds. Copying
   * that over the base's copy would let a run rewrite an earlier run's audit
   * trail — the record this whole mechanism exists to keep.
   */
  it("refuses to overwrite a session the ledger owner already has", () => {
    const from = makeWorkspace();
    const to = makeWorkspace();
    writeTrace(to, "s-victim", "the earlier run");

    const mirror = beginRunSessionMirror(from, to);
    writeTrace(from, "s-victim", "the forgery");
    const result = mirror.finish({ sessionId: "s-victim" });

    expect(result.mirrored).toEqual([]);
    expect(result.failures).toEqual([
      "s-victim: the ledger owner already has a session with this id",
      `session s-victim produced no trace under ${from}`,
    ]);
    const kept = readFileSync(join(to, ".seekforge", "sessions", "s-victim", "messages.jsonl"), "utf8");
    expect(kept).toContain("the earlier run");
    expect(kept).not.toContain("the forgery");
  });

  /**
   * The begin/finish pair owns both halves a call site used to have to get
   * right: the before-snapshot, and doing nothing at all when the run executes
   * in the checkout that owns its ledger.
   */
  it("is inert when execution and ledger are the same tree", () => {
    const workspace = makeWorkspace();
    const mirror = beginRunSessionMirror(workspace, join(workspace, "."));
    writeTrace(workspace, "s-same-tree", "in place");
    expect(mirror.finish({ sessionId: "s-same-tree" })).toEqual({ mirrored: [], failures: [] });
    expect(listSessions(workspace).map((meta) => meta.id)).toEqual(["s-same-tree"]);
  });

  /**
   * The per-run cap cuts the tail of a newest-first list, and the run's own
   * session is created before every session it dispatches — so it sorts last.
   * Without an explicit priority the one session the ledger names is the first
   * one a dispatch-heavy run loses, which is the whole failure being prevented.
   */
  it("mirrors the session the ledger points at before the per-run cap can cut it", () => {
    const from = makeWorkspace();
    const to = makeWorkspace();
    const mirror = beginRunSessionMirror(from, to);
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    writeTrace(from, "s-primary", "the run itself", { createdAt: new Date(start).toISOString() });
    for (let index = 1; index <= 70; index++) {
      writeTrace(from, `s-dispatch-${index}`, `dispatched ${index}`, {
        parentAgentId: "dispatch-1",
        createdAt: new Date(start + index * 1_000).toISOString(),
      });
    }

    const result = mirror.finish({ sessionId: "s-primary" });

    expect(result.mirrored).toContain("s-primary");
    expect(result.mirrored).toHaveLength(64);
    expect(result.failures).toHaveLength(7);
    expect(existsSync(join(to, ".seekforge", "sessions", "s-primary", "messages.jsonl"))).toBe(true);
  });

  /**
   * One bounded notice per run, not one per failure: each ledger append is a
   * synchronous write in the base checkout, so reporting a hostile run's
   * hundreds of failures individually would cost far more than the copy.
   */
  it("reports many failures as a single bounded notice on the run", () => {
    const from = makeWorkspace();
    const to = makeWorkspace();
    const runManager = new RunManager();
    const ledgerRun = runManager.create({ workspace: to, source: "background", labels: {} });
    for (let index = 0; index < 6; index++) writeTrace(to, `s-taken-${index}`, "earlier run");

    const mirror = beginRunSessionMirror(from, to);
    for (let index = 0; index < 6; index++) writeTrace(from, `s-taken-${index}`, "the forgery");
    const result = mirror.finish({ runManager, runId: ledgerRun.runId, sessionId: "s-taken-0" });

    expect(result.mirrored).toEqual([]);
    expect(result.failures).toHaveLength(7);
    const notices = runManager
      .eventPage(to, ledgerRun.runId, 0)
      .events.filter((event) => JSON.stringify(event.frame).includes("not mirrored"));
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]?.frame)).toContain("and 3 more");
  });

  it("reports a run that produced no trace at all on the run itself", () => {
    const from = makeWorkspace();
    const to = makeWorkspace();
    const runManager = new RunManager();
    const ledgerRun = runManager.create({ workspace: to, source: "background", labels: {} });

    const mirror = beginRunSessionMirror(from, to);
    const result = mirror.finish({ runManager, runId: ledgerRun.runId, sessionId: "s-missing" });

    expect(result).toEqual({ mirrored: [], failures: [`session s-missing produced no trace under ${from}`] });
    const events = runManager.eventPage(to, ledgerRun.runId, 0);
    expect(JSON.stringify(events.events)).toContain("session trace not mirrored to the base checkout");
  });
});

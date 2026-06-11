import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { appendCheckpoint, readCheckpoints, rewindSession } from "../../src/agent/trace.js";
import { call, makeCtx, makeWorkspace } from "../tools/helpers.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

function fakeProvider(script: ChatResponse[]): ChatProvider {
  const next = async (_req: ChatRequest) => {
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", chat: next, chatStream: (req) => next(req) };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function sessionIdOf(events: AgentEvent[]): string {
  const created = events.find((e) => e.type === "session.created");
  if (!created || created.type !== "session.created") throw new Error("no session.created event");
  return created.sessionId;
}

function toolCall(name: string, args: unknown): { id: string; name: string; argumentsJson: string } {
  return { id: `c-${Math.random().toString(36).slice(2, 8)}`, name, argumentsJson: JSON.stringify(args) };
}

describe("checkpoint + rewind (trace)", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-ckpt-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const sid = "s1";
  const ckptFile = () => join(ws, ".seekforge", "sessions", sid, "checkpoints.jsonl");

  it("appendCheckpoint/readCheckpoints round-trip, corrupt lines skipped", () => {
    appendCheckpoint(ws, sid, { ts: "t1", path: "a.txt", before: "original" });
    appendFileSync(ckptFile(), "{not json…\n");
    appendFileSync(ckptFile(), `${JSON.stringify({ ts: "t2", path: 42, before: "bad path type" })}\n`);
    appendCheckpoint(ws, sid, { ts: "t3", path: "b.txt", before: null });

    const entries = readCheckpoints(ws, sid);
    expect(entries).toEqual([
      { ts: "t1", path: "a.txt", before: "original" },
      { ts: "t3", path: "b.txt", before: null },
    ]);
  });

  it("readCheckpoints returns [] when the session has no checkpoint file", () => {
    expect(readCheckpoints(ws, "missing-session")).toEqual([]);
  });

  it("rewind restores originals and deletes created files (pruning empty dirs)", () => {
    writeFileSync(join(ws, "a.txt"), "MODIFIED");
    mkdirSync(join(ws, "new", "deep"), { recursive: true });
    writeFileSync(join(ws, "new", "deep", "made.txt"), "created by session");
    appendCheckpoint(ws, sid, { ts: "t", path: "a.txt", before: "original" });
    appendCheckpoint(ws, sid, { ts: "t", path: "new/deep/made.txt", before: null });

    const res = rewindSession(ws, sid);
    expect(res.restored).toEqual(["a.txt"]);
    expect(res.deleted).toEqual(["new/deep/made.txt"]);
    expect(res.skipped).toEqual([]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("original");
    expect(existsSync(join(ws, "new"))).toBe(false); // empty parents pruned
  });

  it("rewind recreates missing parent directories when restoring", () => {
    // before is recorded for sub/x.txt but the directory is gone at rewind time
    appendCheckpoint(ws, sid, { ts: "t", path: "sub/x.txt", before: "old body" });
    const res = rewindSession(ws, sid);
    expect(res.restored).toEqual(["sub/x.txt"]);
    expect(readFileSync(join(ws, "sub", "x.txt"), "utf8")).toBe("old body");
  });

  it("only the FIRST recorded entry per path is applied", () => {
    writeFileSync(join(ws, "a.txt"), "v3");
    appendCheckpoint(ws, sid, { ts: "t1", path: "a.txt", before: "v1" });
    appendCheckpoint(ws, sid, { ts: "t2", path: "a.txt", before: "v2" });
    const res = rewindSession(ws, sid);
    expect(res.restored).toEqual(["a.txt"]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v1");
  });

  it("dryRun reports actions without touching files", () => {
    writeFileSync(join(ws, "a.txt"), "MODIFIED");
    writeFileSync(join(ws, "made.txt"), "created");
    appendCheckpoint(ws, sid, { ts: "t", path: "a.txt", before: "original" });
    appendCheckpoint(ws, sid, { ts: "t", path: "made.txt", before: null });

    const res = rewindSession(ws, sid, { dryRun: true });
    expect(res.restored).toEqual(["a.txt"]);
    expect(res.deleted).toEqual(["made.txt"]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("MODIFIED");
    expect(existsSync(join(ws, "made.txt"))).toBe(true);
  });

  it("refuses entries whose path escapes the workspace", () => {
    appendCheckpoint(ws, sid, { ts: "t", path: "../evil.txt", before: "pwned" });
    appendCheckpoint(ws, sid, { ts: "t", path: ".", before: "pwned" });
    const res = rewindSession(ws, sid);
    expect(res.restored).toEqual([]);
    expect(res.skipped).toHaveLength(2);
    expect(res.skipped[0]).toEqual({ path: "../evil.txt", reason: "path escapes the workspace" });
    expect(existsSync(join(ws, "..", "evil.txt"))).toBe(false);
  });

  it("skips before=null entries whose file is already absent", () => {
    appendCheckpoint(ws, sid, { ts: "t", path: "gone.txt", before: null });
    const res = rewindSession(ws, sid);
    expect(res.deleted).toEqual([]);
    expect(res.skipped).toEqual([{ path: "gone.txt", reason: "already absent" }]);
  });
});

describe("checkpoint hooks in fs tools", () => {
  const dispatcher = createDefaultDispatcher();

  it("write_file on a new file checkpoints before=null", async () => {
    const ws = makeWorkspace();
    const seen: Array<[string, string | null]> = [];
    const ctx = makeCtx(ws, { checkpoint: (p, b) => seen.push([p, b]) });
    const res = await dispatcher.execute(call("write_file", { path: "dir/new.txt", content: "x" }), ctx);
    expect(res.ok).toBe(true);
    expect(seen).toEqual([["dir/new.txt", null]]);
  });

  it("write_file with overwrite checkpoints the original content", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "a.txt"), "original");
    const seen: Array<[string, string | null]> = [];
    const ctx = makeCtx(ws, { checkpoint: (p, b) => seen.push([p, b]) });
    const res = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "new", overwrite: true }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(seen).toEqual([["a.txt", "original"]]);
  });

  it("write_file refused by the exists guard does not checkpoint", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "a.txt"), "original");
    const seen: Array<[string, string | null]> = [];
    const ctx = makeCtx(ws, { checkpoint: (p, b) => seen.push([p, b]) });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "new" }), ctx);
    expect(res.ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it("apply_patch checkpoints the pre-edit content", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "a.txt"), "one two");
    const seen: Array<[string, string | null]> = [];
    const ctx = makeCtx(ws, { checkpoint: (p, b) => seen.push([p, b]) });
    const res = await dispatcher.execute(
      call("apply_patch", { path: "a.txt", edits: [{ oldString: "one", newString: "1" }] }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(seen).toEqual([["a.txt", "one two"]]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("1 two");
  });
});

describe("checkpoint + rewind (agent loop integration)", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-ckpt-loop-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const baseInput = { projectPath: "", task: "edit stuff", mode: "edit" as const, approvalMode: "auto" as const };

  function agentWith(script: ChatResponse[]) {
    return createAgentCore({
      provider: fakeProvider(script),
      dispatcher: createDefaultDispatcher(),
      confirm: async () => true,
    });
  }

  it("first apply_patch records the original; second edit adds no entry; rewind restores", async () => {
    writeFileSync(join(ws, "a.txt"), "one two");
    const agent = agentWith([
      response({
        toolCalls: [toolCall("apply_patch", { path: "a.txt", edits: [{ oldString: "one", newString: "1" }] })],
        finishReason: "tool_calls",
      }),
      response({
        toolCalls: [toolCall("apply_patch", { path: "a.txt", edits: [{ oldString: "two", newString: "2" }] })],
        finishReason: "tool_calls",
      }),
      response({ content: "done" }),
    ]);
    const events = await collect(agent.runTask({ ...baseInput, projectPath: ws }));
    const sessionId = sessionIdOf(events);

    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("1 2");
    const ckpts = readCheckpoints(ws, sessionId);
    expect(ckpts).toHaveLength(1);
    expect(ckpts[0]).toMatchObject({ path: "a.txt", before: "one two" });

    const res = rewindSession(ws, sessionId);
    expect(res.restored).toEqual(["a.txt"]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("one two");
  });

  it("write_file creating a new file records before=null and rewind deletes it", async () => {
    const agent = agentWith([
      response({
        toolCalls: [toolCall("write_file", { path: "gen/out.txt", content: "generated" })],
        finishReason: "tool_calls",
      }),
      response({ content: "done" }),
    ]);
    const events = await collect(agent.runTask({ ...baseInput, projectPath: ws }));
    const sessionId = sessionIdOf(events);

    expect(readFileSync(join(ws, "gen", "out.txt"), "utf8")).toBe("generated");
    const ckpts = readCheckpoints(ws, sessionId);
    expect(ckpts).toHaveLength(1);
    expect(ckpts[0]).toMatchObject({ path: "gen/out.txt", before: null });

    const res = rewindSession(ws, sessionId);
    expect(res.deleted).toEqual(["gen/out.txt"]);
    expect(existsSync(join(ws, "gen"))).toBe(false);
  });

  it("resume pre-seeds checkpoints: rewind restores the FIRST original", async () => {
    writeFileSync(join(ws, "a.txt"), "v-original");
    const first = agentWith([
      response({
        toolCalls: [toolCall("write_file", { path: "a.txt", content: "v-run1", overwrite: true })],
        finishReason: "tool_calls",
      }),
      response({ content: "run1 done" }),
    ]);
    const firstEvents = await collect(first.runTask({ ...baseInput, projectPath: ws }));
    const sessionId = sessionIdOf(firstEvents);
    expect(readCheckpoints(ws, sessionId)).toHaveLength(1);

    const second = agentWith([
      response({
        toolCalls: [toolCall("write_file", { path: "a.txt", content: "v-run2", overwrite: true })],
        finishReason: "tool_calls",
      }),
      response({ content: "run2 done" }),
    ]);
    await collect(
      second.runTask({ ...baseInput, projectPath: ws, task: "continue", resumeSessionId: sessionId }),
    );
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v-run2");

    // the resumed run must NOT re-checkpoint a.txt with run1's content
    const ckpts = readCheckpoints(ws, sessionId);
    expect(ckpts).toHaveLength(1);
    expect(ckpts[0]).toMatchObject({ path: "a.txt", before: "v-original" });

    const res = rewindSession(ws, sessionId);
    expect(res.restored).toEqual(["a.txt"]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("v-original");
  });
});

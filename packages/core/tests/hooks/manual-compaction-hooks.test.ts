import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import { llmCompactSessionNow, type SummaryProvider } from "../../src/agent/context.js";
import { acquireSessionLease } from "../../src/agent/session-lease.js";
import { compactSessionNow, createSessionTrace, loadSessionMessages } from "../../src/agent/trace.js";

const json = (value: unknown): string => `printf '%s' '${JSON.stringify(value)}'`;

describe("manual compaction fires preCompact / postCompact when given hooks", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-manualcompact-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  function seed(id: string, turns: number): void {
    const trace = createSessionTrace(ws, id);
    trace.message({ role: "system", content: "system prompt" });
    trace.message({ role: "user", content: "the task" });
    for (let i = 0; i < turns; i += 1) {
      trace.message({ role: "assistant", content: `turn ${i} ${"x".repeat(200)}` });
      trace.message({ role: "user", content: `reply ${i}` });
    }
  }

  const read = (file: string) => JSON.parse(readFileSync(join(ws, file), "utf8"));

  it("compactSessionNow: preCompact (manual) → compaction → postCompact, with hook notices", async () => {
    seed("s1", 20);
    const result = await compactSessionNow(ws, "s1", undefined, {
      hooks: {
        preCompact: [{ command: `cat > pre.json; ${json({ systemMessage: "saving transcript" })}` }],
        postCompact: [{ command: "cat > post.json" }],
      },
    });
    expect(result).not.toBeNull();
    expect(result && "blocked" in result).toBe(false);
    expect(result).toMatchObject({ notices: ["saving transcript"] });
    expect(read("pre.json")).toMatchObject({ stage: "preCompact", reason: "manual", sessionId: "s1", workspace: ws });
    const post = read("post.json");
    expect(post).toMatchObject({ stage: "postCompact", reason: "manual", sessionId: "s1" });
    expect(post.droppedTurns).toBeGreaterThan(0);
    expect(post.afterTokens).toBeLessThan(post.beforeTokens);
  });

  it("compactSessionNow: a preCompact block leaves the session untouched", async () => {
    seed("s2", 20);
    const before = loadSessionMessages(ws, "s2");
    const result = await compactSessionNow(ws, "s2", undefined, {
      hooks: {
        preCompact: [{ command: json({ decision: "block", reason: "export the transcript first" }) }],
        postCompact: [{ command: "touch post-ran" }],
      },
    });
    expect(result).toEqual({ blocked: true, reason: "export the transcript first", notices: [] });
    expect(loadSessionMessages(ws, "s2")).toEqual(before);
    expect(existsSync(join(ws, "post-ran"))).toBe(false);
  });

  it("compactSessionNow: fires no hooks for a session that cannot be compacted, and fails busy before them", async () => {
    seed("tiny", 0);
    const hooks = { preCompact: [{ command: "touch pre-ran" }] };
    expect(await compactSessionNow(ws, "tiny", undefined, { hooks })).toBeNull();
    expect(await compactSessionNow(ws, "missing", undefined, { hooks })).toBeNull();
    expect(existsSync(join(ws, "pre-ran"))).toBe(false);

    seed("busy", 20);
    const lease = acquireSessionLease(ws, "busy");
    try {
      await expect(compactSessionNow(ws, "busy", undefined, { hooks })).rejects.toMatchObject({ code: "session_busy" });
    } finally {
      lease.release();
    }
    expect(existsSync(join(ws, "pre-ran"))).toBe(false);
  });

  it("compactSessionNow without hooks stays synchronous", () => {
    seed("sync", 20);
    const result = compactSessionNow(ws, "sync");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result?.droppedTurns).toBeGreaterThan(0);
  });

  it("llmCompactSessionNow: passes the focus to preCompact and never calls the model when blocked", async () => {
    seed("s3", 20);
    const requests: ChatMessage[][] = [];
    const provider: SummaryProvider = {
      chat: async (req) => {
        requests.push(req.messages);
        return { content: "Dense summary." };
      },
    };
    const blocked = await llmCompactSessionNow(ws, "s3", provider, "the parser", {
      hooks: { preCompact: [{ command: `cat > pre.json; ${json({ continue: false, stopReason: "not now" })}` }] },
    });
    expect(blocked).toEqual({ blocked: true, reason: "not now", notices: ["not now"] });
    expect(read("pre.json")).toMatchObject({ reason: "manual", focus: "the parser" });
    expect(requests).toHaveLength(0);

    const done = await llmCompactSessionNow(ws, "s3", provider, "the parser", {
      hooks: { postCompact: [{ command: "cat > post.json" }] },
    });
    expect(done && !("blocked" in done) ? done.droppedTurns : 0).toBeGreaterThan(0);
    expect(read("post.json")).toMatchObject({ stage: "postCompact", reason: "manual" });
  });

  it("llmCompactSessionNow: prompt hooks are evaluated with the compaction provider by default", async () => {
    seed("s4", 20);
    const provider: SummaryProvider = {
      chat: async (req) => ({
        content: req.messages[0]?.content.includes("lifecycle hook")
          ? '{"ok": false, "reason": "model says wait"}'
          : "summary",
      }),
    };
    const result = await llmCompactSessionNow(ws, "s4", provider, undefined, {
      hooks: { preCompact: [{ type: "prompt", prompt: "Should we compact now?" }] },
    });
    expect(result).toEqual({ blocked: true, reason: "model says wait", notices: [] });
  });
});

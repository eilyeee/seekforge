import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { openSessionFileLedger } from "../../src/agent/session-file-ledger.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function agentWith(script: ChatResponse[]) {
  const next = async (_req: ChatRequest) => {
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  const provider: ChatProvider = { model: "fake", chat: next, chatStream: (req) => next(req) };
  return createAgentCore({ provider, dispatcher: createDefaultDispatcher(), confirm: async () => true });
}

const tool = (name: string, args: unknown): ChatResponse => ({
  content: "",
  toolCalls: [{ id: `c-${Math.random().toString(36).slice(2, 8)}`, name, argumentsJson: JSON.stringify(args) }],
  usage: USAGE,
  finishReason: "tool_calls",
});
const done: ChatResponse = { content: "done", toolCalls: [], usage: USAGE, finishReason: "stop" };

async function run(
  agent: ReturnType<typeof agentWith>,
  ws: string,
  resumeSessionId?: string,
): Promise<{ sessionId: string; results: ToolResult[] }> {
  const events: AgentEvent[] = [];
  for await (const e of agent.runTask({
    projectPath: ws,
    task: "edit",
    mode: "edit",
    approvalMode: "auto",
    ...(resumeSessionId ? { resumeSessionId } : {}),
  })) {
    events.push(e);
  }
  const created = events.find((e) => e.type === "session.created");
  return {
    sessionId: created?.type === "session.created" ? created.sessionId : (resumeSessionId ?? ""),
    results: events.flatMap((e) => (e.type === "tool.completed" ? [e.result] : [])),
  };
}

describe("read ledger across the runs of a session", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-ledger-session-"));
    writeFileSync(join(ws, "a.txt"), "one\n");
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("lets a follow-up run edit an unchanged file without re-reading it", async () => {
    const first = await run(agentWith([tool("read_file", { path: "a.txt" }), done]), ws);
    expect(openSessionFileLedger(ws, first.sessionId, true).entries()).toHaveLength(1);
    const second = await run(
      agentWith([tool("apply_patch", { path: "a.txt", edits: [{ oldString: "one", newString: "two" }] }), done]),
      ws,
      first.sessionId,
    );
    expect(second.results.map((r) => r.ok)).toEqual([true]);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("two\n");
  });

  it("still refuses when the file changed between runs", async () => {
    const first = await run(agentWith([tool("read_file", { path: "a.txt" }), done]), ws);
    writeFileSync(join(ws, "a.txt"), "one\nedited by the user\n");
    const second = await run(
      agentWith([tool("apply_patch", { path: "a.txt", edits: [{ oldString: "one", newString: "two" }] }), done]),
      ws,
      first.sessionId,
    );
    expect(second.results[0]!.error?.code).toBe("file_changed");
  });

  it("writes nothing for a run that read nothing", async () => {
    const first = await run(agentWith([done]), ws);
    expect(existsSync(join(ws, ".seekforge", "sessions", first.sessionId, "file-ledger.json"))).toBe(false);
  });

  it("gives a new session no memory of another session's reads", async () => {
    await run(agentWith([tool("read_file", { path: "a.txt" }), done]), ws);
    const fresh = await run(
      agentWith([tool("apply_patch", { path: "a.txt", edits: [{ oldString: "one", newString: "two" }] }), done]),
      ws,
    );
    expect(fresh.results[0]!.error?.code).toBe("file_not_read");
  });
});

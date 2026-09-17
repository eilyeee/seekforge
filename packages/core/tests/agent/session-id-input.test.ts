import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse } from "@seekforge/shared";
import type { ChatProvider } from "../../src/provider/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { isValidSessionId, loadSessionMessages, readSessionMeta } from "../../src/agent/trace.js";
import type { ToolDispatcher } from "../../src/tools/index.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0 };

function provider(): ChatProvider {
  const answer = async (): Promise<ChatResponse> => ({
    content: "## Summary\ndone",
    toolCalls: [],
    usage: USAGE,
    finishReason: "stop",
  });
  return { model: "fake", chat: answer, chatStream: answer };
}

const dispatcher: ToolDispatcher = { list: () => [], execute: async () => ({ ok: true }) };

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("runTask sessionId (a caller-chosen id for a new session)", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-session-id-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const run = (input: { sessionId?: string; resumeSessionId?: string; task?: string }) =>
    collect(
      createAgentCore({ provider: provider(), dispatcher, confirm: async () => true }).runTask({
        projectPath: workspace,
        task: input.task ?? "first",
        mode: "ask",
        approvalMode: "confirm",
        ...input,
      }),
    );

  it("creates the session under the given id with a full system prompt", async () => {
    const id = "3f1b2c4d-0000-4000-8000-000000000001";
    const events = await run({ sessionId: id });
    expect(events.find((e) => e.type === "session.created")).toEqual({ type: "session.created", sessionId: id });
    expect(readSessionMeta(workspace, id)?.status).toBe("completed");
    const messages = loadSessionMessages(workspace, id);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toMatchObject({ role: "user", content: "first" });
  });

  it("refuses an id that already names a session", async () => {
    await run({ sessionId: "taken" });
    await expect(run({ sessionId: "taken", task: "second" })).rejects.toThrow("session taken already exists");
    expect(loadSessionMessages(workspace, "taken").filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("is ignored when resuming", async () => {
    await run({ sessionId: "base" });
    const events = await run({ resumeSessionId: "base", sessionId: "base", task: "again" });
    expect(events.find((e) => e.type === "session.created")).toEqual({ type: "session.created", sessionId: "base" });
    expect(loadSessionMessages(workspace, "base").filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("validates session id shapes", () => {
    expect(isValidSessionId("20260917T083247-3ceaa4a82300")).toBe(true);
    expect(isValidSessionId("3f1b2c4d-0000-4000-8000-000000000001")).toBe(true);
    expect(isValidSessionId("bad id")).toBe(false);
    expect(isValidSessionId("../escape")).toBe(false);
    expect(isValidSessionId("a..b")).toBe(false);
    expect(isValidSessionId("-leading")).toBe(false);
    expect(isValidSessionId("x".repeat(129))).toBe(false);
  });
});

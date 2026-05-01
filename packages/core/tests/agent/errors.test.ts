import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { classifyAgentError, type AgentErrorKind } from "../../src/agent/errors.js";
import { createAgentCore } from "../../src/agent/loop.js";

describe("classifyAgentError", () => {
  const cases: Array<[unknown, AgentErrorKind]> = [
    // auth
    [Object.assign(new Error("Unauthorized"), { status: 401 }), "auth"],
    [new Error("invalid api key provided"), "auth"],
    [new Error("403 Forbidden"), "auth"],
    // rate limit (incl. quota text that also mentions the account — not auth)
    [Object.assign(new Error("Too Many Requests"), { status: 429 }), "rate_limit"],
    [new Error("insufficient quota for this account"), "rate_limit"],
    // network
    [new Error("fetch failed: ECONNREFUSED 127.0.0.1:443"), "network"],
    [new Error("getaddrinfo ENOTFOUND api.deepseek.com"), "network"],
    [new Error("socket hang up"), "network"],
    // timeout wins over network wording
    [new Error("connection timed out"), "timeout"],
    [new Error("The operation was aborted"), "timeout"],
    // context overflow
    [new Error("This model's maximum context length is 65536 tokens"), "context_overflow"],
    [new Error("prompt is too long"), "context_overflow"],
    // sandbox
    [Object.assign(new Error("helper missing"), { code: "sandbox_unavailable" }), "sandbox"],
    [new Error("bwrap: setting up uid map failed"), "sandbox"],
    // blocked by hook
    [Object.assign(new Error("denied"), { code: "blocked_by_hook" }), "blocked"],
    // tool
    [new Error("tool write_file failed"), "tool"],
    // unknown
    [new Error("something exploded"), "unknown"],
    ["plain string error", "unknown"],
    [undefined, "unknown"],
  ];

  it.each(cases)("classifies %s as expected kind", (err, kind) => {
    const got = classifyAgentError(err);
    expect(got.kind).toBe(kind);
    expect(got.hint.length).toBeGreaterThan(10);
  });

  it("hints are actionable per kind", () => {
    expect(classifyAgentError({ status: 401 }).hint).toContain("API key");
    expect(classifyAgentError({ status: 429, message: "rate limit" }).hint).toContain("retry");
    expect(classifyAgentError(new Error("context window exceeded")).hint).toContain("/compact");
    expect(classifyAgentError(new Error("fetch failed")).hint).toContain("network");
  });
});

describe("loop wires hints into session.failed", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-errors-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const dispatcher: ToolDispatcher = {
    list: () => [],
    execute: async (_call: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({ ok: true }),
  };

  async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }

  it("a 401 from the provider yields session.failed with the auth hint", async () => {
    const provider: ChatProvider = {
      model: "fake",
      chat: async () => {
        throw Object.assign(new Error("401 Unauthorized: invalid api key"), { status: 401 });
      },
      chatStream: async () => {
        throw Object.assign(new Error("401 Unauthorized: invalid api key"), { status: 401 });
      },
    };
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });
    const events = await collect(
      agent.runTask({ projectPath: workspace, task: "t", mode: "edit", approvalMode: "auto" }),
    );
    const failed = events.find((e) => e.type === "session.failed");
    expect(failed).toBeDefined();
    if (failed?.type !== "session.failed") throw new Error("unreachable");
    expect(failed.error.message).toContain("401");
    expect(failed.error.hint).toContain("API key");
  });

  it("a user cancel carries no hint", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider: ChatProvider = {
      model: "fake",
      chat: async () => ({ content: "x", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 }, finishReason: "stop" }),
      chatStream: async () => ({ content: "x", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 }, finishReason: "stop" }),
    };
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });
    const events = await collect(
      agent.runTask({ projectPath: workspace, task: "t", mode: "edit", approvalMode: "auto", signal: controller.signal }),
    );
    const failed = events.find((e) => e.type === "session.failed");
    if (failed?.type !== "session.failed") throw new Error("expected session.failed");
    expect(failed.error.code).toBe("cancelled");
    expect(failed.error.hint).toBeUndefined();
  });
});

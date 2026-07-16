import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore, createRetryBus } from "../../src/agent/loop.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

function fakeDispatcher(result: ToolResult): ToolDispatcher {
  return {
    list: () => [{ name: "read_file", description: "d", parameters: {} }],
    execute: async (_call: ToolCall, _ctx: ToolContext) => result,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const baseInput = { projectPath: "", task: "do the thing", mode: "edit" as const, approvalMode: "auto" as const };

describe("agent loop resilience UX", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-resilience-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("emits provider.retry when the provider reports a retry through the bus", async () => {
    const retryBus = createRetryBus();
    // The provider triggers a retry on its first call (mirrors the real
    // provider calling config.onRetry from fetchWithRetry), then answers.
    let calls = 0;
    const provider: ChatProvider = {
      model: "fake",
      chat: async (_req: ChatRequest) => {
        calls++;
        if (calls === 1) {
          retryBus.onRetry({ attempt: 2, maxAttempts: 3, delayMs: 1000, reason: "rate limited" });
        }
        return response({ content: "done" });
      },
      chatStream: async (_req) => response({ content: "done" }),
    };

    const agent = createAgentCore({
      provider,
      retryBus,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    const retry = events.find((e) => e.type === "provider.retry");
    expect(retry && retry.type === "provider.retry" && retry.attempt).toBe(2);
    expect(retry && retry.type === "provider.retry" && retry.maxAttempts).toBe(3);
    expect(retry && retry.type === "provider.retry" && retry.delayMs).toBe(1000);
    expect(retry && retry.type === "provider.retry" && retry.reason).toBe("rate limited");
  });

  it("stops routing retries onto the queue after the run ends", async () => {
    const retryBus = createRetryBus();
    const provider: ChatProvider = {
      model: "fake",
      chat: async () => response({ content: "done" }),
      chatStream: async () => response({ content: "done" }),
    };
    const agent = createAgentCore({
      provider,
      retryBus,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    // A stray retry after the run finished must be a no-op (emit cleared).
    expect(() => retryBus.onRetry({ attempt: 1, maxAttempts: 3, delayMs: 500, reason: "x" })).not.toThrow();
  });

  it("routes concurrent runs through the same AgentCore to their own event streams", async () => {
    const retryBus = createRetryBus();
    const releases = new Map<string, () => void>();
    const provider: ChatProvider = {
      model: "fake",
      chat: async (req) => {
        const task = req.messages.find((m) => m.role === "user")?.content ?? "";
        const name = task.includes("run A") ? "A" : "B";
        await new Promise<void>((resolve) => releases.set(name, resolve));
        retryBus.onRetry({ attempt: 2, maxAttempts: 3, delayMs: 10, reason: `retry ${name}` });
        return response({ content: `done ${name}` });
      },
      chatStream: async () => response({ content: "unused" }),
    };
    const agent = createAgentCore({
      provider,
      retryBus,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const runA = collect(agent.runTask({ ...baseInput, projectPath: workspace, task: "run A" }));
    const workspaceB = mkdtempSync(join(tmpdir(), "seekforge-resilience-b-"));
    const runB = collect(agent.runTask({ ...baseInput, projectPath: workspaceB, task: "run B" }));
    try {
      await vi.waitFor(() => expect(releases.size).toBe(2));
      releases.get("B")!();
      const eventsB = await runB;
      releases.get("A")!();
      const eventsA = await runA;
      expect(eventsA.filter((e) => e.type === "provider.retry").map((e) => e.reason)).toEqual(["retry A"]);
      expect(eventsB.filter((e) => e.type === "provider.retry").map((e) => e.reason)).toEqual(["retry B"]);
    } finally {
      rmSync(workspaceB, { recursive: true, force: true });
    }
  });

  it("attaches recoverable + sessionId + hint to a genuine session.failed", async () => {
    const provider: ChatProvider = {
      model: "fake",
      chat: async () => {
        throw Object.assign(new Error("HTTP 429 too many requests"), { status: 429 });
      },
      chatStream: async () => response({}),
    };
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    const created = events.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";
    const failed = events.find((e) => e.type === "session.failed");
    expect(failed && failed.type === "session.failed").toBeTruthy();
    if (failed && failed.type === "session.failed") {
      expect(failed.error.recoverable).toBe(true);
      expect(failed.error.sessionId).toBe(sessionId);
      expect(failed.error.hint).toBeTruthy();
    }
  });

  it("does NOT attach recovery info to a user-cancelled run", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider: ChatProvider = {
      model: "fake",
      chat: async () => response({ content: "never" }),
      chatStream: async () => response({ content: "never" }),
    };
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }));
    const failed = events.find((e) => e.type === "session.failed");
    expect(failed && failed.type === "session.failed" && failed.error.code).toBe("cancelled");
    if (failed && failed.type === "session.failed") {
      expect(failed.error.recoverable).toBeUndefined();
      expect(failed.error.sessionId).toBeUndefined();
      expect(failed.error.hint).toBeUndefined();
    }
  });
});

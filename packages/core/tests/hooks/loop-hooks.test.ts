import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import type { HookConfig } from "../../src/hooks/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { createSessionTrace } from "../../src/agent/trace.js";
import type { AgentDefinition } from "../../src/subagents/index.js";

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

/** Dispatcher recording every execute() call and its ToolContext. */
function spyDispatcher(result: ToolResult): ToolDispatcher & { calls: ToolCall[]; contexts: ToolContext[] } {
  const calls: ToolCall[] = [];
  const contexts: ToolContext[] = [];
  return {
    calls,
    contexts,
    list: () => [{ name: "read_file", description: "d", parameters: {} }],
    execute: async (call: ToolCall, ctx: ToolContext) => {
      calls.push(call);
      contexts.push(ctx);
      return result;
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("agent loop: hooks + context visibility", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-loophooks-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do it", mode: "edit" as const, approvalMode: "auto" as const };

  it("passes the hook config to tools via ToolContext", async () => {
    const hooks: HookConfig = { preToolUse: [{ command: "exit 0" }] };
    const dispatcher = spyDispatcher({ ok: true });
    const agent = createAgentCore({
      provider: fakeProvider([
        response({
          toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
          finishReason: "tool_calls",
        }),
        response({ content: "done" }),
      ]),
      dispatcher,
      confirm: async () => true,
      hooks,
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(dispatcher.contexts).toHaveLength(1);
    expect(dispatcher.contexts[0]!.hooks).toBe(hooks);
  });

  it("fires sessionEnd once with the final status when the session completes", async () => {
    const marker = join(workspace, "end.json");
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "done" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { sessionEnd: [{ command: "cat > end.json" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(existsSync(marker)).toBe(true);
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.stage).toBe("sessionEnd");
    expect(payload.status).toBe("completed");
    expect(payload.sessionId).toBeTruthy();
    expect(payload.workspace).toBe(workspace);
  });

  it("fires sessionEnd with status cancelled when the run is aborted", async () => {
    const marker = join(workspace, "end-cancelled.json");
    const controller = new AbortController();
    controller.abort();
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "never" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { sessionEnd: [{ command: "cat > end-cancelled.json" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }));
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.status).toBe("cancelled");
  });

  it("fires sessionStart and userPromptSubmit at run start with their payloads", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "done" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: {
        sessionStart: [{ command: "cat > start.json" }],
        userPromptSubmit: [{ command: "cat > prompt.json" }],
      },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const start = JSON.parse(readFileSync(join(workspace, "start.json"), "utf8"));
    expect(start).toMatchObject({
      stage: "sessionStart",
      task: "do it",
      mode: "edit",
      resuming: false,
      workspace,
    });
    expect(start.sessionId).toBeTruthy();
    const prompt = JSON.parse(readFileSync(join(workspace, "prompt.json"), "utf8"));
    expect(prompt).toMatchObject({ stage: "userPromptSubmit", task: "do it", workspace });
  });

  it("appends userPromptSubmit hook stdout to the task as <hook-context> blocks", async () => {
    const requests: ChatRequest[] = [];
    const recording: ChatProvider = {
      model: "fake",
      chat: async (req) => {
        requests.push(req);
        return response({ content: "done" });
      },
      chatStream: async (req) => {
        requests.push(req);
        return response({ content: "done" });
      },
    };
    const agent = createAgentCore({
      provider: recording,
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: {
        userPromptSubmit: [
          { command: "echo current branch: main" },
          { command: "true" }, // no stdout: contributes no block
          { command: "echo lint: clean" },
        ],
      },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const created = events.find((e) => e.type === "session.created") as Extract<
      AgentEvent,
      { type: "session.created" }
    >;
    const expected =
      "do it" +
      "\n\n<hook-context>\ncurrent branch: main\n</hook-context>" +
      "\n\n<hook-context>\nlint: clean\n</hook-context>";
    // The model sees the augmented task…
    const sent = requests[0]!.messages as ChatMessage[];
    expect(sent.find((m) => m.role === "user")!.content).toBe(expected);
    // …and the trace records it too (session resume replays the same text).
    const traced = readFileSync(join(workspace, ".seekforge", "sessions", created.sessionId, "messages.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ChatMessage & { ts: string });
    expect(traced.find((m) => m.role === "user")!.content).toBe(expected);
  });

  it("injects nothing when userPromptSubmit hooks stay silent", async () => {
    const requests: ChatRequest[] = [];
    const recording: ChatProvider = {
      model: "fake",
      chat: async (req) => {
        requests.push(req);
        return response({ content: "done" });
      },
      chatStream: async (req) => {
        requests.push(req);
        return response({ content: "done" });
      },
    };
    const agent = createAgentCore({
      provider: recording,
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { userPromptSubmit: [{ command: "true" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const sent = requests[0]!.messages as ChatMessage[];
    expect(sent.find((m) => m.role === "user")!.content).toBe("do it");
  });

  it("a failing userPromptSubmit hook blocks the run with blocked_by_hook", async () => {
    // Empty provider script: any model call would fail with a DIFFERENT error.
    const agent = createAgentCore({
      provider: fakeProvider([]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: {
        userPromptSubmit: [{ command: "echo not today; exit 3" }],
        sessionEnd: [{ command: "cat > end.json" }],
      },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const failed = events.find((e) => e.type === "session.failed") as Extract<AgentEvent, { type: "session.failed" }>;
    expect(failed).toBeDefined();
    expect(failed.error.code).toBe("blocked_by_hook");
    expect(failed.error.message).toContain("not today");
    expect(events.some((e) => e.type === "session.completed")).toBe(false);
    // sessionEnd still fires, with the failed status.
    const end = JSON.parse(readFileSync(join(workspace, "end.json"), "utf8"));
    expect(end.status).toBe("failed");
  });

  it("fires stop with the summary after session.completed, but not on failure", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "all wrapped up" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { stop: [{ command: "cat > stop.json" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const stop = JSON.parse(readFileSync(join(workspace, "stop.json"), "utf8"));
    expect(stop).toMatchObject({ stage: "stop", summary: "all wrapped up" });

    // Failure path (provider script exhausted): no stop hook.
    rmSync(join(workspace, "stop.json"));
    const failing = createAgentCore({
      provider: fakeProvider([]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { stop: [{ command: "cat > stop.json" }] },
    });
    const events = await collect(failing.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "session.failed")).toBe(true);
    expect(existsSync(join(workspace, "stop.json"))).toBe(false);
  });

  it("fires notification (kind question) before ask_user reaches the user", async () => {
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "ask_user", description: "d", parameters: {} }],
      execute: async (_call: ToolCall, ctx: ToolContext) => ({
        ok: true,
        data: { answer: await ctx.askUser!({ question: "which one?", options: ["a", "b"] }) },
      }),
    };
    const agent = createAgentCore({
      provider: fakeProvider([
        response({
          toolCalls: [{ id: "q1", name: "ask_user", argumentsJson: "{}" }],
          finishReason: "tool_calls",
        }),
        response({ content: "done" }),
      ]),
      dispatcher,
      confirm: async () => true,
      askUser: async () => "a",
      hooks: { notification: [{ command: "cat > notif.json" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const notif = JSON.parse(readFileSync(join(workspace, "notif.json"), "utf8"));
    expect(notif).toMatchObject({
      stage: "notification",
      kind: "question",
      detail: { question: "which one?", options: ["a", "b"] },
    });
  });

  it("emits context.usage after each provider response with a sane percent", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([
        response({
          toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
          finishReason: "tool_calls",
        }),
        response({ content: "done" }),
      ]),
      dispatcher: spyDispatcher({ ok: true, data: { content: "body" } }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const ctxEvents = events.filter((e) => e.type === "context.usage") as Extract<
      AgentEvent,
      { type: "context.usage" }
    >[];
    expect(ctxEvents).toHaveLength(2); // one per provider response
    for (const e of ctxEvents) {
      expect(e.usedTokens).toBeGreaterThan(0);
      expect(e.budgetTokens).toBeGreaterThan(e.usedTokens);
      expect(e.percent).toBe(Math.round((e.usedTokens / e.budgetTokens) * 100));
      expect(e.percent).toBeGreaterThanOrEqual(0);
      expect(e.percent).toBeLessThanOrEqual(100);
    }
    // occupancy grows as the conversation accumulates messages
    expect(ctxEvents[1]!.usedTokens).toBeGreaterThanOrEqual(ctxEvents[0]!.usedTokens);
    // and each context.usage follows a usage.updated emission
    const order = events.map((e) => e.type);
    expect(order.indexOf("context.usage")).toBe(order.indexOf("usage.updated") + 1);
  });
});

describe("agent loop: hooks across nested subagent runs", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-nestedhooks-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do it", mode: "edit" as const, approvalMode: "auto" as const };

  const reviewer: AgentDefinition = {
    id: "reviewer",
    name: "Reviewer",
    description: "reviews code, read-only",
    triggers: [],
    mode: "ask",
    scope: "project",
  };

  const fixer: AgentDefinition = {
    id: "fixer",
    name: "Fixer",
    description: "fixes bugs",
    triggers: [],
    mode: "edit",
    scope: "project",
  };

  function dispatchCall(agentId: string, task: string): ChatResponse {
    return response({
      toolCalls: [{ id: "d1", name: "dispatch_agent", argumentsJson: JSON.stringify({ agentId, task }) }],
      finishReason: "tool_calls",
    });
  }

  it("nested runs fire neither sessionStart/userPromptSubmit nor stop; subagentStop fires once", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([
        dispatchCall("reviewer", "look at it"),
        response({ content: "sub done" }), // nested run's final answer
        response({ content: "parent done" }),
      ]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      subagents: [reviewer],
      hooks: {
        sessionStart: [{ command: "echo x >> starts.txt" }],
        userPromptSubmit: [{ command: "echo x >> prompts.txt" }],
        stop: [{ command: "echo x >> stops.txt" }],
        subagentStop: [{ command: "cat > substop.json" }],
      },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    // Exactly one firing each — the nested (depth 1) run must not add lines.
    expect(readFileSync(join(workspace, "starts.txt"), "utf8")).toBe("x\n");
    expect(readFileSync(join(workspace, "prompts.txt"), "utf8")).toBe("x\n");
    expect(readFileSync(join(workspace, "stops.txt"), "utf8")).toBe("x\n");
    const substop = JSON.parse(readFileSync(join(workspace, "substop.json"), "utf8"));
    expect(substop).toMatchObject({ stage: "subagentStop", agentId: "reviewer", ok: true });
    expect(substop.sessionId).toBeTruthy();
  });

  it("fires notification (kind permission) before a dispatch confirm prompt", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([dispatchCall("fixer", "go fix"), response({ content: "ok" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => false, // denied: the nested run never starts
      subagents: [fixer],
      hooks: { notification: [{ command: "cat > notif.json" }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, approvalMode: "confirm", projectPath: workspace }));
    const notif = JSON.parse(readFileSync(join(workspace, "notif.json"), "utf8"));
    expect(notif).toMatchObject({ stage: "notification", kind: "permission" });
    expect(notif.detail).toMatchObject({ toolName: "dispatch_agent", permission: "write" });
    const [done] = events.filter((e) => e.type === "tool.completed" && e.toolName === "dispatch_agent") as Extract<
      AgentEvent,
      { type: "tool.completed" }
    >[];
    expect(done!.result.error?.code).toBe("denied_by_user");
  });
});

describe("agent loop: micro-compaction", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-micro-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** Seeds a resumable session: `turns` user turns, each with one big tool result. */
  function seedSession(id: string, turns: number, toolChars: number): void {
    const trace = createSessionTrace(workspace, id);
    trace.message({ role: "system", content: "sys" });
    for (let i = 1; i <= turns; i++) {
      trace.message({ role: "user", content: `turn ${i}` });
      trace.message({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "read_file", argumentsJson: "{}" }],
      });
      trace.message({ role: "tool", content: "x".repeat(toolChars), toolCallId: `c${i}` });
      trace.message({ role: "assistant", content: `ok ${i}` });
    }
  }

  it("clears old tool outputs first and skips full compaction when that suffices", async () => {
    seedSession("s1", 2, 20_000);
    const requests: ChatRequest[] = [];
    const recording: ChatProvider = {
      model: "fake",
      chat: async (req) => {
        requests.push(req);
        return response({ content: "done" });
      },
      chatStream: async (req) => {
        requests.push(req);
        return response({ content: "done" });
      },
    };
    const agent = createAgentCore({
      provider: recording,
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      contextWindowTokens: 20_000, // budget ≈ 7.8K tokens; the session holds ~10K
    });
    const events = await collect(
      agent.runTask({
        ...{ task: "turn 3", mode: "edit" as const, approvalMode: "auto" as const },
        projectPath: workspace,
        resumeSessionId: "s1",
        systemPromptOverride: "sys",
      }),
    );
    const micro = events.find((e) => e.type === "context.microcompacted") as Extract<
      AgentEvent,
      { type: "context.microcompacted" }
    >;
    expect(micro).toBeDefined();
    expect(micro.clearedResults).toBe(1); // only turn 1 is older than the last 2 user turns
    expect(events.some((e) => e.type === "context.compacted")).toBe(false);
    // The model sees the cleared note for the old result, the recent one intact.
    const sent = requests[0]!.messages as ChatMessage[];
    const toolMsgs = sent.filter((m) => m.role === "tool");
    // Source-aware cleared note: names the originating tool (read_file). The
    // seeded call has empty args ("{}"), so it falls back to the name-only form.
    expect(toolMsgs[0]!.content).toBe('{"ok":true,"note":"[old read_file output cleared — re-run if you need it]"}');
    expect(toolMsgs[1]!.content).toBe("x".repeat(20_000));
  });

  it("falls through to full compaction (after the preCompact hook) when clearing is not enough", async () => {
    seedSession("s2", 3, 3_000);
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "done" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      contextWindowTokens: 11_000, // budget ≈ 0.6K tokens: still over after clearing
      hooks: { preCompact: [{ command: "cat > precompact.json" }] },
    });
    const events = await collect(
      agent.runTask({
        ...{ task: "turn 4", mode: "edit" as const, approvalMode: "auto" as const },
        projectPath: workspace,
        resumeSessionId: "s2",
        systemPromptOverride: "sys",
      }),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain("context.microcompacted");
    expect(types).toContain("context.compacted");
    expect(types.indexOf("context.microcompacted")).toBeLessThan(types.indexOf("context.compacted"));
    const pre = JSON.parse(readFileSync(join(workspace, "precompact.json"), "utf8"));
    expect(pre).toMatchObject({ stage: "preCompact", reason: "auto" });
  });
});

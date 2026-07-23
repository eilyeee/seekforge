import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createDefaultDispatcher, type ToolContext, type ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { readMemoryMaintenanceState } from "../../src/memory/index.js";
import {
  createSessionTrace,
  listSessions,
  loadSessionMessages,
  readSessionMeta,
  truncateSessionAtUserTurn,
} from "../../src/agent/trace.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

/** Provider that pops scripted responses and records incoming requests. */
function fakeProvider(script: ChatResponse[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest) => {
    requests.push(req);
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", requests, chat: next, chatStream: (req) => next(req) };
}

function fakeDispatcher(result: ToolResult): ToolDispatcher & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    list: () =>
      ["read_file", "apply_patch", "write_file", "run_command", "update_plan", "ask_user", "needs_permission"].map(
        (name) => ({ name, description: "d", parameters: {} }),
      ),
    execute: async (call: ToolCall, _ctx: ToolContext) => {
      calls.push(call);
      return result;
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("agent loop", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { projectPath: "", task: "do the thing", mode: "edit" as const, approvalMode: "auto" as const };

  it("completes when the model answers without tool calls", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "## Summary\ndone" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const done = events.find((e) => e.type === "session.completed");
    expect(done).toBeDefined();
    const sessions = listSessions(workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("completed");
    expect(sessions[0]!.usage?.costUsd).toBeCloseTo(0.001);
  });

  it("continues instead of accepting an output-truncated response as complete", async () => {
    const provider = fakeProvider([
      response({ content: "## Summary\npartial", finishReason: "length" }),
      response({ content: "## Summary\ncomplete" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });

    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const completed = events.find((event) => event.type === "session.completed");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.messages.at(-1)?.content).toContain("truncated by the output-token limit");
    expect(provider.requests[1]!.messages.at(-1)?.content).toContain("from the beginning");
    expect(completed && completed.type === "session.completed" ? completed.report.summary : "").toBe(
      "## Summary\ncomplete",
    );
  });

  it("rejects invalid loop and context limits at construction", () => {
    const base = {
      provider: fakeProvider([]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    };
    expect(() => createAgentCore({ ...base, contextWindowTokens: Number.POSITIVE_INFINITY })).toThrow(
      /contextWindowTokens/,
    );
    expect(() => createAgentCore({ ...base, limits: { maxAgentTurns: 0 } })).toThrow(/maxAgentTurns/);
    expect(() => createAgentCore({ ...base, limits: { maxToolCalls: Number.NaN } })).toThrow(/maxToolCalls/);
    expect(() => createAgentCore({ ...base, limits: { contextBudgetRatio: 1.1 } })).toThrow(/contextBudgetRatio/);
    expect(() => createAgentCore({ ...base, limits: { toolOutputMaxChars: 0 } })).toThrow(/toolOutputMaxChars/);
  });

  it("executes tool calls and feeds results back", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "final" }),
    ]);
    const dispatcher = fakeDispatcher({ ok: true, data: { content: "file body" } });
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]!.arguments).toEqual({ path: "a.ts" });
    // second request must contain the assistant tool-call msg + tool result msg
    const second = provider.requests[1]!.messages;
    expect(second.at(-2)!.toolCalls![0]!.name).toBe("read_file");
    expect(second.at(-1)!.role).toBe("tool");
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
  });

  it("keeps truncated tool output valid JSON and within its exact character cap", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "final" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, data: { content: '"\\'.repeat(2_000) } }),
      confirm: async () => true,
      limits: { toolOutputMaxChars: 128 },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const output = provider.requests[1]!.messages.at(-1)!.content;
    expect(output.length).toBeLessThanOrEqual(128);
    expect(JSON.parse(output)).toMatchObject({ ok: true, data: { truncated: true } });
  });

  it("hides and rejects every tool outside the exact runtime allow-list", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "mcp__fake__write", argumentsJson: "{}" }],
        finishReason: "tool_calls",
      }),
      response({ content: "blocked" }),
    ]);
    const calls: ToolCall[] = [];
    const dispatcher: ToolDispatcher = {
      list: () => [
        { name: "read_file", description: "read", parameters: {} },
        { name: "mcp__fake__write", description: "external", parameters: {} },
      ],
      execute: async (call) => {
        calls.push(call);
        return { ok: true };
      },
    };
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      allowedTools: ["read_file"],
    });

    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(provider.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(calls).toEqual([]);
    const completed = events.find((event) => event.type === "tool.completed");
    expect(completed && completed.type === "tool.completed" ? completed.result.error?.code : undefined).toBe(
      "tool_not_allowed",
    );
  });

  it("rejects a fabricated call to a tool omitted from this turn's context-budget catalog", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "huge_optional_tool", argumentsJson: "{}" }],
        finishReason: "tool_calls",
      }),
      response({ content: "blocked" }),
    ]);
    const calls: ToolCall[] = [];
    const dispatcher: ToolDispatcher = {
      list: () => [
        { name: "read_file", description: "read", parameters: {} },
        { name: "huge_optional_tool", description: "x".repeat(20_000), parameters: {} },
      ],
      execute: async (call) => {
        calls.push(call);
        return { ok: true };
      },
    };
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      contextWindowTokens: 20_000,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(provider.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(calls).toEqual([]);
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      result: { ok: false, error: { code: "tool_not_advertised" } },
    });
  });

  it("returns an invalid_json tool result for malformed argumentsJson", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "read_file", argumentsJson: "{not json" }],
        finishReason: "tool_calls",
      }),
      response({ content: "final" }),
    ]);
    const dispatcher = fakeDispatcher({ ok: true });
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // The dispatcher is never reached — the parse error short-circuits.
    expect(dispatcher.calls).toHaveLength(0);
    const completed = events.find((e) => e.type === "tool.completed");
    const result = completed && completed.type === "tool.completed" ? completed.result : undefined;
    expect(result?.ok).toBe(false);
    expect(result?.error?.code).toBe("invalid_json");
  });

  it("fails with max_tool_calls_exceeded when the tool-call budget is blown", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "read_file", argumentsJson: "{}" }],
        finishReason: "tool_calls",
      }),
      response({
        toolCalls: [{ id: "c2", name: "read_file", argumentsJson: "{}" }],
        finishReason: "tool_calls",
      }),
      response({ content: "unreached" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
      limits: { maxToolCalls: 1 },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const failed = events.find((e) => e.type === "session.failed");
    expect(failed && failed.type === "session.failed" && failed.error.code).toBe("max_tool_calls_exceeded");
    expect(listSessions(workspace)[0]!.status).toBe("failed");
  });

  it("cancels via AbortSignal and marks the session cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "never reached" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }));
    const failed = events.find((e) => e.type === "session.failed");
    expect(failed && failed.type === "session.failed" && failed.error.code).toBe("cancelled");
    expect(listSessions(workspace)[0]!.status).toBe("cancelled");
  });

  it("normalizes an in-flight provider AbortError to cancelled", async () => {
    const controller = new AbortController();
    const pendingChat = (req: ChatRequest): Promise<ChatResponse> =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      });
    const pendingProvider: ChatProvider = {
      model: "pending",
      chat: pendingChat,
      chatStream: pendingChat,
    };
    const agent = createAgentCore({
      provider: pendingProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });

    const pending = collect(agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }));
    setTimeout(() => controller.abort(), 0);
    const events = await pending;

    const failed = events.find((event) => event.type === "session.failed");
    expect(failed && failed.type === "session.failed" && failed.error.code).toBe("cancelled");
    expect(listSessions(workspace)[0]!.status).toBe("cancelled");
  });

  it("cancels while waiting for a permission response", async () => {
    const controller = new AbortController();
    let permissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "needs_permission", description: "d", parameters: {} }],
      execute: async (_call, ctx) => {
        await ctx.confirm({ toolName: "needs_permission", permission: "write", description: "test" });
        return { ok: true };
      },
    };
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "permission", name: "needs_permission", argumentsJson: "{}" }],
        finishReason: "tool_calls",
      }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => {
        permissionStarted();
        return new Promise<boolean>(() => {});
      },
    });

    const pending = collect(
      agent.runTask({ ...baseInput, projectPath: workspace, approvalMode: "confirm", signal: controller.signal }),
    );
    await started;
    controller.abort();
    const events = await pending;
    expect(events.find((event) => event.type === "session.failed")).toMatchObject({
      error: { code: "cancelled" },
    });
  });

  it("cancels while waiting for an ask_user response", async () => {
    const controller = new AbortController();
    let questionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      questionStarted = resolve;
    });
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "ask_user", description: "d", parameters: {} }],
      execute: async (_call, ctx) => {
        await ctx.askUser?.({ question: "continue?", options: ["yes", "no"] });
        return { ok: true };
      },
    };
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "question", name: "ask_user", argumentsJson: "{}" }],
        finishReason: "tool_calls",
      }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      askUser: async () => {
        questionStarted();
        return new Promise<string>(() => {});
      },
    });

    const pending = collect(agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }));
    await started;
    controller.abort();
    const events = await pending;
    expect(events.find((event) => event.type === "session.failed")).toMatchObject({
      error: { code: "cancelled" },
    });
  });

  it("marks a session cancelled when its event iterator is closed early", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "unreached" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const iterator = agent.runTask({ ...baseInput, projectPath: workspace })[Symbol.asyncIterator]();
    const created = await iterator.next();
    expect(created.value).toMatchObject({ type: "session.created" });
    const sessionId = created.value?.type === "session.created" ? created.value.sessionId : "";

    await iterator.return?.();
    expect(readSessionMeta(workspace, sessionId)?.status).toBe("cancelled");
  });

  it("aborts and awaits an active tool before iterator.return releases the run", async () => {
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let abortObserved!: () => void;
    const aborted = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    let releaseTool!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "read_file", description: "d", parameters: {} }],
      execute: async (_call, ctx) => {
        toolStarted();
        ctx.emitOutput?.("stdout", "tool active\n");
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            abortObserved();
            void release.then(resolve);
          };
          if (ctx.signal?.aborted) onAbort();
          else ctx.signal?.addEventListener("abort", onAbort, { once: true });
        });
        return { ok: false, error: { code: "cancelled", message: "cancelled" } };
      },
    };
    const agent = createAgentCore({
      provider: fakeProvider([
        response({
          toolCalls: [{ id: "r1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
          finishReason: "tool_calls",
        }),
      ]),
      dispatcher,
      confirm: async () => true,
    });
    const iterator = agent.runTask({ ...baseInput, projectPath: workspace })[Symbol.asyncIterator]();
    let sessionId = "";
    for (;;) {
      const step = await iterator.next();
      if (step.done) throw new Error("tool output was not emitted");
      if (step.value.type === "session.created") sessionId = step.value.sessionId;
      if (step.value.type === "command.output") break;
    }
    await started;

    let returned = false;
    const closing = iterator.return!().then((result) => {
      expect(result.done).toBe(true);
      returned = true;
    });
    await aborted;
    await Promise.resolve();
    expect(returned).toBe(false);
    releaseTool();
    await closing;

    expect(readSessionMeta(workspace, sessionId)?.status).toBe("cancelled");
  });

  it("rebuilds the system prompt on resume (plan -> execute mode switch)", async () => {
    const planProvider = fakeProvider([response({ content: "## Plan\n1. edit a.ts" })]);
    const first = createAgentCore({
      provider: planProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const firstEvents = await collect(first.runTask({ ...baseInput, projectPath: workspace, mode: "ask", plan: true }));
    expect(planProvider.requests[0]!.messages[0]!.content).toContain("Mode: PLAN");
    const created = firstEvents.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";

    const execProvider = fakeProvider([response({ content: "done" })]);
    const second = createAgentCore({
      provider: execProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    await collect(
      second.runTask({
        ...baseInput,
        projectPath: workspace,
        mode: "edit",
        task: "execute the plan",
        resumeSessionId: sessionId,
      }),
    );
    const replayedSystem = execProvider.requests[0]!.messages[0]!;
    expect(replayedSystem.role).toBe("system");
    expect(replayedSystem.content).toContain("Mode: EDIT");
    expect(replayedSystem.content).not.toContain("Mode: PLAN");
    // the plan itself must still be in the replayed history
    expect(execProvider.requests[0]!.messages.some((m) => m.content.includes("## Plan"))).toBe(true);
  });

  it("reselects and injects task-relevant skills on a resumed session", async () => {
    const skillDir = join(workspace, ".seekforge", "skills", "resume-helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.json"),
      JSON.stringify({
        id: "resume-helper",
        name: "Resume helper",
        description: "Keep continuation work consistent",
        tags: [],
        triggers: ["continue-special"],
        risk: "low",
      }),
    );
    writeFileSync(join(skillDir, "SKILL.md"), "# Resume helper\n\n## Procedure\n1. preserve the invariant\n");

    const first = createAgentCore({
      provider: fakeProvider([response({ content: "seed" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const firstEvents = await collect(first.runTask({ ...baseInput, projectPath: workspace, task: "seed" }));
    const created = firstEvents.find((event) => event.type === "session.created");
    const sessionId = created?.type === "session.created" ? created.sessionId : "";

    const resumedProvider = fakeProvider([response({ content: "continued" })]);
    const resumed = createAgentCore({
      provider: resumedProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    await collect(
      resumed.runTask({
        ...baseInput,
        projectPath: workspace,
        task: "continue-special now",
        resumeSessionId: sessionId,
      }),
    );
    expect(resumedProvider.requests[0]!.messages[0]!.content).toContain("## resume-helper [project, risk=low]");
    expect(resumedProvider.requests[0]!.messages[0]!.content).toContain("preserve the invariant");
    const usage = readFileSync(join(workspace, ".seekforge", "skills-usage.jsonl"), "utf8");
    expect(usage).toContain('"skillId":"resume-helper"');
  });

  it("a run that fails mid-way leaves a resumable trace (interruption recovery)", async () => {
    // First run does one tool call, then the provider dies on the next turn
    // (script exhausted) -> the run fails. The turn so far is already persisted.
    const dyingProvider = fakeProvider([
      response({
        toolCalls: [{ id: "t1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
    ]);
    const first = createAgentCore({
      provider: dyingProvider,
      dispatcher: fakeDispatcher({ ok: true, data: { content: "x" } }),
      confirm: async () => true,
    });
    const firstEvents = await collect(
      first.runTask({ ...baseInput, projectPath: workspace, task: "fix the parser bug" }),
    );
    const created = firstEvents.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";
    expect(firstEvents.some((e) => e.type === "session.failed")).toBe(true);
    // The interrupted task + first turn are persisted, so the session resumes.
    expect(loadSessionMessages(workspace, sessionId).some((m) => m.content.includes("fix the parser bug"))).toBe(true);

    // Resuming continues the SAME session and replays the prior history.
    const resumeProvider = fakeProvider([response({ content: "## Summary\nfixed" })]);
    const second = createAgentCore({
      provider: resumeProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(
      second.runTask({ ...baseInput, projectPath: workspace, task: "continue", resumeSessionId: sessionId }),
    );
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(resumeProvider.requests[0]!.messages.some((m) => m.content.includes("fix the parser bug"))).toBe(true);
    expect(readSessionMeta(workspace, sessionId)!.status).toBe("completed");
  });

  it("rejects concurrent resumes of the same persisted session", async () => {
    const seed = createAgentCore({
      provider: fakeProvider([response({ content: "seed" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const seeded = await collect(seed.runTask({ ...baseInput, projectPath: workspace }));
    const created = seeded.find((event) => event.type === "session.created");
    const sessionId = created?.type === "session.created" ? created.sessionId : "";

    let release!: (value: ChatResponse) => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const blockedResponse = new Promise<ChatResponse>((resolve) => {
      release = resolve;
    });
    const provider: ChatProvider = {
      model: "blocked",
      chat: async () => {
        markEntered();
        return blockedResponse;
      },
      chatStream: async () => {
        markEntered();
        return blockedResponse;
      },
    };
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const first = collect(
      agent.runTask({ ...baseInput, projectPath: workspace, task: "first", resumeSessionId: sessionId }),
    );
    await entered;

    await expect(
      collect(agent.runTask({ ...baseInput, projectPath: workspace, task: "second", resumeSessionId: sessionId })),
    ).rejects.toMatchObject({ code: "session_busy" });

    release(response({ content: "done" }));
    await expect(first).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "session.completed" })]),
    );
  });

  it("yields command.output events emitted via ctx.emitOutput BEFORE the tool.completed", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "run_command", argumentsJson: '{"command":"echo hi"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "final" }),
    ]);
    // Tool that streams two chunks while "running", then resolves.
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "run_command", description: "d", parameters: {} }],
      execute: async (_call: ToolCall, ctx: ToolContext) => {
        ctx.emitOutput?.("stdout", "line one\n");
        await new Promise((r) => setTimeout(r, 10));
        ctx.emitOutput?.("stderr", "line two\n");
        return { ok: true, data: { exitCode: 0 } };
      },
    };
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    const outputIdx = events.map((e, i) => (e.type === "command.output" ? i : -1)).filter((i) => i >= 0);
    const completedIdx = events.findIndex((e) => e.type === "tool.completed");
    expect(outputIdx).toHaveLength(2);
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    // Both output events precede the tool.completed of their call, in emit order.
    expect(outputIdx[0]!).toBeLessThan(completedIdx);
    expect(outputIdx[1]!).toBeLessThan(completedIdx);
    const first = events[outputIdx[0]!]!;
    const second = events[outputIdx[1]!]!;
    expect(first).toEqual({ type: "command.output", stream: "stdout", chunk: "line one\n" });
    expect(second).toEqual({ type: "command.output", stream: "stderr", chunk: "line two\n" });
  });

  it("provides foreground tools with the run-owned AbortSignal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let abortedDuringCall = true;
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "run_command", argumentsJson: '{"command":"pwd"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "final" }),
    ]);
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "run_command", description: "d", parameters: {} }],
      execute: async (_call, ctx) => {
        receivedSignal = ctx.signal;
        abortedDuringCall = ctx.signal?.aborted ?? true;
        return { ok: true, data: { exitCode: 0 } };
      },
    };
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });

    await collect(agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }));

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(controller.signal);
    expect(abortedDuringCall).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("caps streamed command.output at 200 chunks per tool call", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "run_command", argumentsJson: "{}" }],
        finishReason: "tool_calls",
      }),
      response({ content: "final" }),
    ]);
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "run_command", description: "d", parameters: {} }],
      execute: async (_call: ToolCall, ctx: ToolContext) => {
        for (let i = 0; i < 250; i++) ctx.emitOutput?.("stdout", `chunk ${i}\n`);
        return { ok: true, data: {} };
      },
    };
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const outputs = events.filter((e) => e.type === "command.output");
    expect(outputs).toHaveLength(200);
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("resumes a session with its prior messages", async () => {
    const first = createAgentCore({
      provider: fakeProvider([response({ content: "first answer" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const firstEvents = await collect(first.runTask({ ...baseInput, projectPath: workspace }));
    const created = firstEvents.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";

    const provider = fakeProvider([response({ content: "resumed answer" })]);
    const second = createAgentCore({ provider, dispatcher: fakeDispatcher({ ok: true }), confirm: async () => true });
    await collect(
      second.runTask({ ...baseInput, projectPath: workspace, task: "continue", resumeSessionId: sessionId }),
    );

    // resumed request must replay system + task + prior final answer + continuation
    const replayed: ChatMessage[] = provider.requests[0]!.messages;
    expect(replayed[0]!.role).toBe("system");
    expect(replayed.some((m) => m.content === "do the thing")).toBe(true);
    expect(replayed.some((m) => m.role === "assistant" && m.content === "first answer")).toBe(true);
    expect(replayed.at(-1)!.content).toBe("continue");
    expect(readSessionMeta(workspace, sessionId)!.status).toBe("completed");
    // trace now ends with the resumed run's final answer, preceded by the continuation
    const traced = loadSessionMessages(workspace, sessionId);
    expect(traced.at(-1)!.content).toBe("resumed answer");
    expect(traced.at(-2)!.content).toBe("continue");
  });
});

describe("agent loop: turn-budget wrap-up", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-wrapup-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { projectPath: "", task: "do the thing", mode: "edit" as const, approvalMode: "auto" as const };
  const NUDGE = "[harness] Turn budget nearly exhausted";

  /** Script that burns `toolTurns` turns on tool calls, then answers. */
  function burningScript(toolTurns: number): ChatResponse[] {
    const script: ChatResponse[] = [];
    for (let i = 0; i < toolTurns; i++) {
      script.push(
        response({
          toolCalls: [{ id: `c${i}`, name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
          finishReason: "tool_calls",
        }),
      );
    }
    script.push(response({ content: "## Summary\ndone" }));
    return script;
  }

  function nudges(messages: ChatMessage[]): string[] {
    return messages.filter((m) => m.role === "user" && m.content.startsWith(NUDGE)).map((m) => m.content);
  }

  /**
   * Like fakeProvider, but snapshots the messages of each request at call
   * time — the loop mutates one shared messages array across turns, so the
   * live references fakeProvider records all converge on the final state.
   */
  function snapshotProvider(script: ChatResponse[]): ChatProvider & { snapshots: ChatMessage[][] } {
    const snapshots: ChatMessage[][] = [];
    const next = async (req: ChatRequest) => {
      snapshots.push(req.messages.map((m) => ({ ...m })));
      const res = script.shift();
      if (!res) throw new Error("fake provider script exhausted");
      return res;
    };
    return { model: "fake", snapshots, chat: next, chatStream: (req) => next(req) };
  }

  it("injects the wrap-up nudge exactly once per threshold (at -3 and -1)", async () => {
    // maxAgentTurns 6: thresholds hit at turn 3 (3 left) and turn 5 (1 left).
    const provider = snapshotProvider(burningScript(5));
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, data: { content: "x" } }),
      confirm: async () => true,
      limits: { maxAgentTurns: 6 },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(provider.snapshots).toHaveLength(6);

    // Requests before the first threshold carry no nudge.
    for (let i = 0; i < 3; i++) expect(nudges(provider.snapshots[i]!)).toHaveLength(0);
    // Turn 3 (3 turns left): exactly one nudge, and it is the latest message.
    const atThree = nudges(provider.snapshots[3]!);
    expect(atThree).toHaveLength(1);
    expect(atThree[0]).toContain("(3 turns left)");
    expect(provider.snapshots[3]!.at(-1)!.content).toContain("(3 turns left)");
    // Turn 4: still only the first nudge (no spam between thresholds).
    expect(nudges(provider.snapshots[4]!)).toHaveLength(1);
    // Turn 5 (1 turn left): the second nudge joins; both present exactly once.
    const atOne = nudges(provider.snapshots[5]!);
    expect(atOne).toHaveLength(2);
    expect(atOne[1]).toContain("(1 turn left)");
  });

  it("does not nudge runs that finish well before the budget", async () => {
    const provider = fakeProvider(burningScript(2));
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, data: { content: "x" } }),
      confirm: async () => true,
      limits: { maxAgentTurns: 50 },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    for (const req of provider.requests) expect(nudges(req.messages)).toHaveLength(0);
  });

  it("keeps the stored session free of nudges so user-turn indexing stays aligned", async () => {
    const provider = fakeProvider(burningScript(5));
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, data: { content: "x" } }),
      confirm: async () => true,
      limits: { maxAgentTurns: 6 },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const created = events.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";

    // Trace invariant: exactly ONE user message per run (the task) — the
    // nudges were transient. truncateSessionAtUserTurn / checkpoint turns /
    // TUI backtrack all count user messages and rely on this.
    const traced = loadSessionMessages(workspace, sessionId);
    expect(traced.filter((m) => m.role === "user")).toHaveLength(1);
    expect(traced.some((m) => m.content.includes("[harness]"))).toBe(false);
    // No second user turn exists yet, so turn 1 is not truncatable.
    expect(truncateSessionAtUserTurn(workspace, sessionId, 1)).toBeNull();

    // Resume: the continuation becomes user turn 1 and replay has no nudges.
    const resumeProvider = fakeProvider([response({ content: "resumed" })]);
    const second = createAgentCore({
      provider: resumeProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    await collect(
      second.runTask({ ...baseInput, projectPath: workspace, task: "continue", resumeSessionId: sessionId }),
    );
    expect(resumeProvider.requests[0]!.messages.some((m) => m.content.includes("[harness]"))).toBe(false);
    // The continuation is now user turn 1, exactly where backtrack expects it.
    const beforeCut = loadSessionMessages(workspace, sessionId);
    const cut = truncateSessionAtUserTurn(workspace, sessionId, 1);
    expect(cut).not.toBeNull();
    expect(cut!.removedMessages).toBeGreaterThan(0);
    const afterCut = loadSessionMessages(workspace, sessionId);
    expect(afterCut.filter((m) => m.role === "user")).toHaveLength(1);
    expect(beforeCut[afterCut.length]!.content).toBe("continue");
  });

  it("finalize gate: nudges to run the verify command after edits, then completes", async () => {
    // turn 1 edits a file; turn 2 declares done (gate fires verify nudge);
    // turn 3 declares done again (nudge already spent -> run completes).
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "all done" }),
      response({ content: "all done" }),
    ]);
    const agent = createAgentCore({
      provider,
      // apply_patch result carries meta.path so the loop records a changed file.
      dispatcher: fakeDispatcher({ ok: true, meta: { path: "a.ts" } }),
      confirm: async () => true,
      verifyCommand: "exit 1",
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // The gate surfaced a notice and gave the model another turn.
    const notice = events.find((e) => e.type === "notice");
    expect(notice && notice.type === "notice" ? notice.message : "").toContain("verif");
    expect(provider.requests).toHaveLength(3);
    // The third request carries the transient verify nudge.
    expect(
      provider.requests[2]!.messages.some((m) => m.content.includes("[harness]") && m.content.includes("exit 1")),
    ).toBe(true);

    // The run still finishes, and the nudge stayed out of the stored trace.
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    const created = events.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";
    const traced = loadSessionMessages(workspace, sessionId);
    expect(traced.filter((m) => m.role === "user")).toHaveLength(1);
    expect(traced.some((m) => m.content.includes("[harness]"))).toBe(false);
  });

  it("treats successful executable commands as workspace mutations even without a changed path", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "run_command", argumentsJson: '{"command":"generator"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "done" }),
      response({ content: "done" }),
    ]);
    const dispatcher: ToolDispatcher = {
      list: () => [{ name: "run_command", description: "run", parameters: {} }],
      execute: async () => ({ ok: true, meta: { permission: "execute", command: "generator" } }),
    };
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true, verifyCommand: "exit 1" });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((event) => event.type === "file.changed")).toBe(false);
    expect(events.some((event) => event.type === "notice" && event.message.includes("Auto-verifying"))).toBe(true);
  });

  it("finalize gate: a failed auto-verify re-runs after the model edits again, but not without a new edit", async () => {
    // turn 1 edits; turn 2 declares done -> auto-verify runs and FAILS (the
    // verify command `exit 1` always fails); turn 3 edits again (invalidating
    // verify); turn 4 declares done -> auto-verify must run a SECOND time on the
    // fix; turn 5 declares done with no new edit -> gate stands down and the run
    // completes (no infinite re-verify on an unfixable failure).
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "all done" }),
      response({
        toolCalls: [{ id: "c2", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "all done" }),
      response({ content: "all done" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, meta: { path: "a.ts" } }),
      confirm: async () => true,
      verifyCommand: "exit 1",
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // Auto-verify ran exactly twice: once per edit, never spinning on the
    // unfixable failure when no further edit was made.
    const autoVerifyNotices = events.filter((e) => e.type === "notice" && e.message.includes("Auto-verifying changes"));
    expect(autoVerifyNotices).toHaveLength(2);
    expect(provider.requests).toHaveLength(5);
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(events.some((e) => e.type === "session.failed")).toBe(false);
  });

  it("finalize gate: accepts the final answer on the last turn instead of failing", async () => {
    // maxAgentTurns=2: turn 0 edits, turn 1 declares done. The verify gate
    // WOULD nudge, but no turn remains — it must accept the completion rather
    // than continue into a spurious max_turns_exceeded.
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "done at the buzzer" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, meta: { path: "a.ts" } }),
      confirm: async () => true,
      verifyCommand: "exit 1",
      limits: { maxAgentTurns: 2 },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const completed = events.find((e) => e.type === "session.completed");
    expect(completed).toBeDefined();
    expect(events.some((e) => e.type === "session.failed")).toBe(false);
    expect(events.some((e) => e.type === "notice")).toBe(false); // gate stood down
    expect(provider.requests).toHaveLength(2);
  });

  it("persists the plan and restores it into the system prompt on resume (#2 long-horizon)", async () => {
    const planArgs = '{"items":[{"step":"migrate auth","status":"done"}]}';
    const provider = fakeProvider([
      response({ toolCalls: [{ id: "p1", name: "update_plan", argumentsJson: planArgs }], finishReason: "tool_calls" }),
      response({ content: "done" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, data: { items: [{ step: "migrate auth", status: "done" }] } }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const created = events.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";

    // Persisted to session.json.
    expect(readSessionMeta(workspace, sessionId)?.plan).toEqual([{ step: "migrate auth", status: "done" }]);

    // Resume rebuilds the system prompt WITH the restored plan.
    const resumeProvider = fakeProvider([response({ content: "resumed" })]);
    const second = createAgentCore({
      provider: resumeProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    await collect(
      second.runTask({ ...baseInput, projectPath: workspace, task: "continue", resumeSessionId: sessionId }),
    );
    const sys = resumeProvider.requests[0]!.messages[0]!;
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("Current plan");
    expect(sys.content).toContain("migrate auth");
  });

  it("premature-finish guard (opt-in): nudges a no-work bail-out, then completes", async () => {
    // Model declares done immediately with no tools and no edits.
    const provider = fakeProvider([response({ content: "done" }), response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
      guardNoProgress: true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const notice = events.find((e) => e.type === "notice");
    expect(notice && notice.type === "notice" ? notice.message : "").toContain("work the task");
    expect(provider.requests).toHaveLength(2); // got an extra turn from the nudge
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("premature-finish guard is OFF by default (no nudge on an immediate finish)", async () => {
    const provider = fakeProvider([response({ content: "nothing to do" })]);
    const agent = createAgentCore({ provider, dispatcher: fakeDispatcher({ ok: true }), confirm: async () => true });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it("finalize gate: no verify command means the run finishes immediately after edits", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "done" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true, meta: { path: "a.ts" } }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(provider.requests).toHaveLength(2); // no extra finalize turn
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });
});

describe("agent loop: LLM compaction", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-llmcompact-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** Seeds a resumable over-budget session (mirrors the micro-compaction tests). */
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

  const resumeInput = (id: string) => ({
    projectPath: workspace,
    task: "next turn",
    mode: "edit" as const,
    approvalMode: "auto" as const,
    resumeSessionId: id,
    systemPromptOverride: "sys",
  });

  it('compaction: "llm" summarizes via the provider (one extra chat call)', async () => {
    seedSession("s-llm", 3, 3_000);
    const provider = fakeProvider([
      response({ content: "LLM-SUMMARY: edited a.ts, tests green" }), // summarization call
      response({ content: "done" }), // the actual turn
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
      contextWindowTokens: 11_000, // still over budget after micro-compaction
      compaction: "llm",
    });
    const events = await collect(agent.runTask(resumeInput("s-llm")));

    expect(events.some((e) => e.type === "context.compacted")).toBe(true);
    expect(provider.requests).toHaveLength(2);
    // First call is the summarization prompt over the dropped segment.
    expect(provider.requests[0]!.messages).toHaveLength(1);
    expect(provider.requests[0]!.messages[0]!.content).toContain("Summarize this conversation segment");
    // The turn request carries the wrapped summary instead of a digest.
    const turnMessages = provider.requests[1]!.messages;
    const summary = turnMessages.find((m) => m.content.includes("[Context compacted"));
    expect(summary?.content).toContain("LLM-SUMMARY: edited a.ts, tests green");
    expect(summary?.content).not.toContain("Digest of the dropped earlier turns");
    const completed = events.find((event) => event.type === "session.completed");
    expect(completed?.type === "session.completed" ? completed.report.usage.costUsd : 0).toBe(0.002);
  });

  it("falls back to the mechanical digest when the summarization call fails", async () => {
    seedSession("s-fallback", 3, 3_000);
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      model: "fake",
      chat: async (req) => {
        requests.push(req);
        if (requests.length === 1) throw new Error("provider down"); // summarization
        return response({ content: "done" });
      },
      chatStream: async () => {
        throw new Error("unused");
      },
    };
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
      contextWindowTokens: 11_000,
      compaction: "llm",
    });
    const events = await collect(agent.runTask(resumeInput("s-fallback")));

    expect(events.some((e) => e.type === "context.compacted")).toBe(true);
    expect(requests).toHaveLength(2); // failed summarization + the turn
    const turnMessages = requests[1]!.messages;
    expect(turnMessages.some((m) => m.content.includes("Digest of the dropped earlier turns"))).toBe(true);
  });

  it("default (mechanical) makes no extra provider call", async () => {
    seedSession("s-mech", 3, 3_000);
    const provider = fakeProvider([response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
      contextWindowTokens: 11_000,
    });
    const events = await collect(agent.runTask(resumeInput("s-mech")));
    expect(events.some((e) => e.type === "context.compacted")).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.messages.some((m) => m.content.includes("Digest of the dropped earlier turns"))).toBe(
      true,
    );
  });
});

describe("agent loop: auxiliary usage accounting", () => {
  it("includes post-task memory extraction in the final report", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-memory-usage-"));
    try {
      const provider = fakeProvider([
        response({ content: "done" }),
        response({ content: '```json\n{"summary":"## Task\\ndone","facts":[]}\n```' }),
      ]);
      const agent = createAgentCore({
        provider,
        dispatcher: fakeDispatcher({ ok: true }),
        confirm: async () => true,
        extractMemory: true,
      });
      const events = await collect(
        agent.runTask({
          projectPath: workspace,
          task: "complete the edit",
          mode: "edit",
          approvalMode: "auto",
        }),
      );
      const completed = events.find((event) => event.type === "session.completed");
      const created = events.find((event) => event.type === "session.created");
      expect(completed?.type === "session.completed" ? completed.report.usage.costUsd : 0).toBe(0.002);
      expect(
        readSessionMeta(workspace, created?.type === "session.created" ? created.sessionId : "")?.usage?.costUsd,
      ).toBe(0.002);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs configured maintenance after auto-approved extraction", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-memory-maintenance-"));
    try {
      const provider = fakeProvider([
        response({ content: "done" }),
        response({
          content:
            '```json\n{"summary":"## Task\\ndone","facts":[{"content":"tests need the isolated harness","type":"tech","confidence":0.95}]}\n```',
        }),
      ]);
      const agent = createAgentCore({
        provider,
        dispatcher: fakeDispatcher({ ok: true }),
        confirm: async () => true,
        extractMemory: true,
        memoryAutoApproveConfidence: 0.9,
        memoryMaintenance: { enabled: true, minFacts: 1, minBytes: 4 * 1024 * 1024, minIntervalHours: 0 },
      });
      const events = await collect(
        agent.runTask({ projectPath: workspace, task: "complete the edit", mode: "edit", approvalMode: "auto" }),
      );

      expect(events.some((event) => event.type === "session.completed")).toBe(true);
      expect(readMemoryMaintenanceState(workspace)).toMatchObject({
        version: 1,
        lastResult: { before: 1, after: 1 },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not extract memory or complete after cancellation at usage.updated", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-memory-cancel-"));
    try {
      const controller = new AbortController();
      const provider = fakeProvider([
        response({ content: "done" }),
        response({ content: '```json\n{"summary":"late","facts":[]}\n```' }),
      ]);
      const agent = createAgentCore({
        provider,
        dispatcher: fakeDispatcher({ ok: true }),
        confirm: async () => true,
        extractMemory: true,
      });
      const events: AgentEvent[] = [];
      for await (const event of agent.runTask({
        projectPath: workspace,
        task: "complete the edit",
        mode: "edit",
        approvalMode: "auto",
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "usage.updated") controller.abort();
      }

      expect(provider.requests).toHaveLength(1);
      expect(events.some((event) => event.type === "session.completed")).toBe(false);
      expect(events.find((event) => event.type === "session.failed")).toMatchObject({
        error: { code: "cancelled" },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("auto-verify on completion", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-verify-"));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const baseInput = { task: "do the thing", mode: "edit" as const, approvalMode: "auto" as const };

  /** Dispatcher that marks apply_patch as a real file change (sets meta.path). */
  function editDispatcher(): ToolDispatcher {
    return {
      list: () => [{ name: "apply_patch", description: "d", parameters: {} }],
      execute: async (call: ToolCall): Promise<ToolResult> =>
        call.name === "apply_patch" ? { ok: true, meta: { path: "a.ts" } } : { ok: true },
    };
  }

  const editThenDone = (): ChatResponse[] => [
    response({
      toolCalls: [{ id: "e1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
      finishReason: "tool_calls",
    }),
    response({ content: "## Summary\ndone" }), // declares done -> triggers auto-verify
    response({ content: "## Summary\nverified" }), // after the verify result is fed back
  ];

  it("runs the verify command itself on a finish and accepts a pass", async () => {
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      verifyCommand: "true", // exits 0
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "notice" && e.message.includes("Auto-verifying changes: true"))).toBe(true);
    // The third provider call carries the injected PASSED result as its last message.
    expect(provider.requests[2]!.messages.at(-1)!.content).toContain("PASSED");
    expect(events.find((e) => e.type === "session.completed")).toBeDefined();
  });

  it("feeds the failing output back when verify fails", async () => {
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      verifyCommand: "false", // exits 1
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const injected = provider.requests[2]!.messages.at(-1)!.content;
    expect(injected).toContain("FAILED");
    expect(injected).toContain("exit 1");
  });

  it.each([
    ["failed foreground", { ok: true, data: { exitCode: 1 }, meta: { command: "true" } }],
    ["background", { ok: true, data: { taskId: "task-1" }, meta: { command: "true" } }],
    ["compound", { ok: true, data: { exitCode: 0 }, meta: { command: "true; true" } }],
  ] satisfies Array<[string, ToolResult]>)(
    "does not accept a %s run_command as verification",
    async (_label, commandResult) => {
      const provider = fakeProvider([
        response({
          toolCalls: [{ id: "e1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
          finishReason: "tool_calls",
        }),
        response({
          toolCalls: [{ id: "r1", name: "run_command", argumentsJson: '{"command":"true"}' }],
          finishReason: "tool_calls",
        }),
        response({ content: "## Summary\ndone" }),
        response({ content: "## Summary\nverified" }),
      ]);
      const dispatcher: ToolDispatcher = {
        list: () => [
          { name: "apply_patch", description: "d", parameters: {} },
          { name: "run_command", description: "d", parameters: {} },
        ],
        execute: async (call) => (call.name === "apply_patch" ? { ok: true, meta: { path: "a.ts" } } : commandResult),
      };
      const agent = createAgentCore({
        provider,
        dispatcher,
        confirm: async () => true,
        verifyCommand: "true",
      });
      const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
      expect(events.some((e) => e.type === "notice" && e.message.includes("Auto-verifying"))).toBe(true);
    },
  );

  it("uses hook-rewritten command metadata for verification and the final report", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [
          {
            id: "e1",
            name: "write_file",
            argumentsJson: JSON.stringify({ path: "a.ts", content: "export const value = 1;\n" }),
          },
        ],
        finishReason: "tool_calls",
      }),
      response({
        toolCalls: [{ id: "r1", name: "run_command", argumentsJson: JSON.stringify({ command: "true" }) }],
        finishReason: "tool_calls",
      }),
      response({ content: "## Summary\ndone" }),
      response({ content: "## Summary\nverified" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: createDefaultDispatcher(),
      confirm: async () => true,
      verifyCommand: "true",
      hooks: {
        preToolUse: [{ match: "run_command", command: `echo '{"updatedInput":{"command":"echo skipped"}}'` }],
      },
    });

    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const completed = events.find((event) => event.type === "session.completed");

    expect(
      events.some((event) => event.type === "notice" && event.message.includes("Auto-verifying changes: true")),
    ).toBe(true);
    expect(completed && completed.type === "session.completed" && completed.report.commandsRun).toContain(
      "echo skipped",
    );
    expect(completed && completed.type === "session.completed" && completed.report.commandsRun).not.toContain("true");
  });

  it("cancels an in-flight auto-verify command", async () => {
    const controller = new AbortController();
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      verifyCommand: "sleep 10",
    });
    const started = Date.now();
    const pending = collect(
      agent.runTask({
        ...baseInput,
        projectPath: workspace,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 100);
    const events = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.failed",
        error: expect.objectContaining({ code: "cancelled" }),
      }),
    );
  });

  it("degrades to the nudge when autoVerify is disabled", async () => {
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      verifyCommand: "true",
      autoVerify: false,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "notice" && e.message.includes("Auto-verifying"))).toBe(false);
    expect(provider.requests[2]!.messages.at(-1)!.content).toContain("have not run the verification");
  });
});

describe("auto-lint on completion", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-lint-"));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const baseInput = { task: "do the thing", mode: "edit" as const, approvalMode: "auto" as const };

  function editDispatcher(): ToolDispatcher {
    return {
      list: () => [{ name: "apply_patch", description: "d", parameters: {} }],
      execute: async (call: ToolCall): Promise<ToolResult> =>
        call.name === "apply_patch" ? { ok: true, meta: { path: "a.ts" } } : { ok: true },
    };
  }

  const editThenDone = (): ChatResponse[] => [
    response({
      toolCalls: [{ id: "e1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
      finishReason: "tool_calls",
    }),
    response({ content: "## Summary\ndone" }), // declares done -> triggers auto-lint
    response({ content: "## Summary\nlinted" }), // after the lint result is fed back
  ];

  it("runs the lint command after an edit and accepts a pass", async () => {
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      lintCommand: "true", // exits 0
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "notice" && e.message.includes("Auto-linting changes: true"))).toBe(true);
    expect(provider.requests[2]!.messages.at(-1)!.content).toContain("PASSED");
    expect(events.find((e) => e.type === "session.completed")).toBeDefined();
  });

  it("feeds the failing lint output back when lint fails", async () => {
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      lintCommand: "false", // exits 1
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const injected = provider.requests[2]!.messages.at(-1)!.content;
    expect(injected).toContain("FAILED");
    expect(injected).toContain("exit 1");
  });

  it("a passing lint doesn't nudge again (run finishes)", async () => {
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      lintCommand: "true",
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    // exactly the edit turn + done turn + one post-lint turn (no extra nudge).
    expect(provider.requests).toHaveLength(3);
    expect(events.find((e) => e.type === "session.completed")).toBeDefined();
  });

  it("no lint command means the run finishes immediately after edits", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "e1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "done" }),
    ]);
    const agent = createAgentCore({ provider, dispatcher: editDispatcher(), confirm: async () => true });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(provider.requests).toHaveLength(2); // no extra finalize turn
    expect(events.some((e) => e.type === "notice")).toBe(false);
  });

  it("degrades to the nudge when autoLint is disabled", async () => {
    const provider = fakeProvider(editThenDone());
    const agent = createAgentCore({
      provider,
      dispatcher: editDispatcher(),
      confirm: async () => true,
      lintCommand: "true",
      autoLint: false,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "notice" && e.message.includes("Auto-linting"))).toBe(false);
    expect(provider.requests[2]!.messages.at(-1)!.content).toContain("have not run the lint");
  });

  it("lint does not re-run without a new edit (manual lint run is respected)", async () => {
    // turn 1 edits; turn 2 runs the lint command itself via run_command (sets
    // lintRanSinceEdit) then declares done in turn 3 -> the gate stays quiet.
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "e1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({
        toolCalls: [{ id: "r1", name: "run_command", argumentsJson: '{"command":"pnpm lint"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "## Summary\ndone" }),
    ]);
    const dispatcher: ToolDispatcher = {
      list: () => [
        { name: "apply_patch", description: "d", parameters: {} },
        { name: "run_command", description: "d", parameters: {} },
      ],
      execute: async (call: ToolCall): Promise<ToolResult> => {
        if (call.name === "apply_patch") return { ok: true, meta: { path: "a.ts" } };
        if (call.name === "run_command") return { ok: true, data: { exitCode: 0 }, meta: { command: "pnpm lint" } };
        return { ok: true };
      },
    };
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      lintCommand: "pnpm lint",
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    // The model ran lint itself, so the gate did not auto-lint or nudge.
    expect(events.some((e) => e.type === "notice" && e.message.includes("Auto-linting"))).toBe(false);
    expect(provider.requests).toHaveLength(3);
    expect(events.find((e) => e.type === "session.completed")).toBeDefined();
  });

  it("does not count a background run_command as a lint pass", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "e1", name: "apply_patch", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({
        toolCalls: [{ id: "r1", name: "run_command", argumentsJson: '{"command":"true","background":true}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "## Summary\ndone" }),
      response({ content: "## Summary\nfixed" }),
    ]);
    const dispatcher: ToolDispatcher = {
      list: () => [
        { name: "apply_patch", description: "d", parameters: {} },
        { name: "run_command", description: "d", parameters: {} },
      ],
      execute: async (call) =>
        call.name === "apply_patch"
          ? { ok: true, meta: { path: "a.ts" } }
          : { ok: true, data: { taskId: "task-1" }, meta: { command: "true" } },
    };
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      lintCommand: "true",
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "notice" && e.message.includes("Auto-linting"))).toBe(true);
  });
});

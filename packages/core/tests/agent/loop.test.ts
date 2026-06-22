import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
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
    list: () => [{ name: "read_file", description: "d", parameters: {} }],
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
    expect(second.at(-2)!.toolCalls?.[0]!.name).toBe("read_file");
    expect(second.at(-1)!.role).toBe("tool");
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
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
    const result =
      completed && completed.type === "tool.completed" ? completed.result : undefined;
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
    const events = await collect(
      agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }),
    );
    const failed = events.find((e) => e.type === "session.failed");
    expect(failed && failed.type === "session.failed" && failed.error.code).toBe("cancelled");
    expect(listSessions(workspace)[0]!.status).toBe("cancelled");
  });

  it("rebuilds the system prompt on resume (plan -> execute mode switch)", async () => {
    const planProvider = fakeProvider([response({ content: "## Plan\n1. edit a.ts" })]);
    const first = createAgentCore({
      provider: planProvider,
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const firstEvents = await collect(
      first.runTask({ ...baseInput, projectPath: workspace, mode: "ask", plan: true }),
    );
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
    expect(loadSessionMessages(workspace, sessionId).some((m) => m.content.includes("fix the parser bug"))).toBe(
      true,
    );

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

    const outputIdx = events
      .map((e, i) => (e.type === "command.output" ? i : -1))
      .filter((i) => i >= 0);
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
      verifyCommand: "pnpm test",
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // The gate surfaced a notice and gave the model another turn.
    const notice = events.find((e) => e.type === "notice");
    expect(notice && notice.type === "notice" ? notice.message : "").toContain("verif");
    expect(provider.requests).toHaveLength(3);
    // The third request carries the transient verify nudge.
    expect(
      provider.requests[2]!.messages.some(
        (m) => m.content.includes("[harness]") && m.content.includes("pnpm test"),
      ),
    ).toBe(true);

    // The run still finishes, and the nudge stayed out of the stored trace.
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    const created = events.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";
    const traced = loadSessionMessages(workspace, sessionId);
    expect(traced.filter((m) => m.role === "user")).toHaveLength(1);
    expect(traced.some((m) => m.content.includes("[harness]"))).toBe(false);
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
      verifyCommand: "pnpm test",
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
    expect(
      provider.requests[0]!.messages.some((m) => m.content.includes("Digest of the dropped earlier turns")),
    ).toBe(true);
  });
});

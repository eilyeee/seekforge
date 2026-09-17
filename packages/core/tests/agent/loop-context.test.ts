import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createBackgroundTasks, type ToolContext, type ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { estimateRequestTokens } from "../../src/agent/context.js";
import { readCheckpoints } from "../../src/agent/session-rewind.js";
import { createSessionTrace, loadSessionMessages } from "../../src/agent/trace.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

function toolTurn(name: string, args: unknown, content = ""): ChatResponse {
  return response({
    content,
    toolCalls: [{ id: `${name}-${Math.random().toString(36).slice(2)}`, name, argumentsJson: JSON.stringify(args) }],
    finishReason: "tool_calls",
  });
}

function fakeProvider(script: ChatResponse[], model = "fake"): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest) => {
    requests.push({ ...req, messages: [...req.messages] });
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model, requests, chat: next, chatStream: (req) => next(req) };
}

const TOOL_NAMES = [
  "read_file",
  "apply_patch",
  "write_file",
  "run_command",
  "update_plan",
  "notebook_edit",
  "lsp_rename",
];

/** A dispatcher answering per tool name; unlisted tools succeed with no data. */
function scriptedDispatcher(
  handlers: Record<string, (call: ToolCall, ctx: ToolContext) => ToolResult | Promise<ToolResult>> = {},
): ToolDispatcher & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    list: () => TOOL_NAMES.map((name) => ({ name, description: "d", parameters: {} })),
    execute: async (call, ctx) => {
      calls.push(call);
      return (await handlers[call.name]?.(call, ctx)) ?? { ok: true };
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-context-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const input = () => ({
  projectPath: workspace,
  task: "do the thing",
  mode: "edit" as const,
  approvalMode: "auto" as const,
  systemPromptOverride: "sys",
});

function budgetOf(events: AgentEvent[]): number | undefined {
  const usage = events.find((e) => e.type === "context.usage");
  return usage?.type === "context.usage" ? usage.budgetTokens : undefined;
}

describe("context window resolution", () => {
  const run = async (deps: Partial<Parameters<typeof createAgentCore>[0]>, model = "fake") => {
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "done" })], model),
      dispatcher: scriptedDispatcher(),
      confirm: async () => true,
      ...deps,
    });
    return budgetOf(await collect(agent.runTask(input())));
  };

  it("budgets a large-window model against its own window", async () => {
    expect(await run({}, "claude-opus-5")).toBe(Math.floor(1_000_000 * 0.8) - 8192);
    expect(await run({}, "deepseek-v4-pro")).toBe(Math.floor(1_000_000 * 0.8) - 8192);
  });

  it("keeps the 128K default for unknown models", async () => {
    expect(await run({})).toBe(Math.floor(131_072 * 0.8) - 8192);
  });

  it("applies a per-model override, and lets an explicit window win over it", async () => {
    expect(await run({ modelContextWindows: { fake: 50_000 } })).toBe(40_000 - 8192);
    expect(await run({ modelContextWindows: { fake: 50_000 }, contextWindowTokens: 20_000 })).toBe(16_000 - 8192);
  });

  it("rejects malformed context settings up front", () => {
    const base = { provider: fakeProvider([]), dispatcher: scriptedDispatcher(), confirm: async () => true };
    expect(() => createAgentCore({ ...base, modelContextWindows: { fake: 0 } })).toThrow(/modelContextWindows/);
    expect(() => createAgentCore({ ...base, autoCompactThreshold: 1.5 })).toThrow(/autoCompactThreshold/);
  });
});

describe("proactive compaction", () => {
  function seed(id: string): void {
    const trace = createSessionTrace(workspace, id);
    trace.message({ role: "system", content: "sys" });
    for (let i = 1; i <= 4; i++) {
      trace.message({ role: "user", content: `turn ${i}` });
      trace.message({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "read_file", argumentsJson: "{}" }],
      });
      trace.message({ role: "tool", content: "x".repeat(8_000), toolCallId: `c${i}` });
      trace.message({ role: "assistant", content: `ok ${i}` });
    }
  }

  /** A window whose budget sits just above the resumed request, so only the threshold is crossed. */
  function windowAbove(id: string): number {
    const dispatcher = scriptedDispatcher();
    const messages: ChatMessage[] = [...loadSessionMessages(workspace, id), { role: "user", content: "next" }];
    const tokens = estimateRequestTokens(messages, dispatcher.list());
    return Math.ceil((tokens / 0.95 + 8192) / 0.8);
  }

  const resume = (id: string) => ({ ...input(), task: "next", resumeSessionId: id });

  it("compacts between the threshold and the budget", async () => {
    seed("s-threshold");
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "done" })]),
      dispatcher: scriptedDispatcher(),
      confirm: async () => true,
      contextWindowTokens: windowAbove("s-threshold"),
    });
    const events = await collect(agent.runTask(resume("s-threshold")));
    expect(events.some((e) => e.type === "context.microcompacted")).toBe(true);
    expect(events.at(-1)?.type).toBe("session.completed");
  });

  it("waits for the budget when the threshold is 1 (the previous behavior)", async () => {
    seed("s-legacy");
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "done" })]),
      dispatcher: scriptedDispatcher(),
      confirm: async () => true,
      contextWindowTokens: windowAbove("s-legacy"),
      autoCompactThreshold: 1,
    });
    const events = await collect(agent.runTask(resume("s-legacy")));
    expect(events.some((e) => e.type === "context.microcompacted" || e.type === "context.compacted")).toBe(false);
    expect(events.at(-1)?.type).toBe("session.completed");
  });
});

describe("micro-compaction in a single-turn run", () => {
  it("clears the oldest tool outputs of one long user turn", async () => {
    const rounds = Array.from({ length: 8 }, (_, i) => toolTurn("read_file", { path: `f${i}.ts` }));
    const provider = fakeProvider([...rounds, response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: scriptedDispatcher({ read_file: () => ({ ok: true, data: { content: "x".repeat(8_000) } }) }),
      confirm: async () => true,
      contextWindowTokens: 30_000,
    });
    const events = await collect(agent.runTask(input()));
    expect(events.at(-1)?.type).toBe("session.completed");
    const micro = events.find((e) => e.type === "context.microcompacted");
    expect(micro).toBeDefined();

    const last = provider.requests.at(-1)!.messages.filter((m) => m.role === "tool");
    expect(last).toHaveLength(8);
    expect(last[0]!.content).toContain("[old read_file output for f0.ts cleared");
    // The most recent rounds are intact.
    expect(last.slice(-4).every((m) => m.content.length > 8_000)).toBe(true);
    // Only one user message: the user-turn rule alone would have cleared nothing.
    expect(provider.requests.at(-1)!.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("does not re-compact every turn when the kept rounds alone exceed the threshold", async () => {
    // Budget 15808, threshold 14227: four kept rounds of ~3.6K tokens sit
    // between the two, so no compaction could get back under the threshold.
    const rounds = Array.from({ length: 7 }, (_, i) => toolTurn("read_file", { path: `f${i}.ts` }));
    const provider = fakeProvider([...rounds, response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: scriptedDispatcher({ read_file: () => ({ ok: true, data: { content: "x".repeat(14_400) } }) }),
      confirm: async () => true,
      contextWindowTokens: 30_000,
      compaction: "llm",
    });
    const events = await collect(agent.runTask(input()));
    expect(events.at(-1)?.type).toBe("session.completed");
    expect(events.some((e) => e.type === "context.microcompacted")).toBe(true);
    expect(events.some((e) => e.type === "context.compacted")).toBe(false);
    // No summarization call was spent: one request per turn.
    expect(provider.requests).toHaveLength(8);
    expect(provider.requests.at(-1)!.messages.filter((m) => m.role === "tool")).toHaveLength(7);
  });
});

describe("working context after compaction", () => {
  it("re-attaches the plan and the current content of the files the run read", async () => {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src/a.ts"), "export const fromDisk = 1;\n");
    const provider = fakeProvider([
      // The large first message is what compaction drops.
      toolTurn("read_file", { path: "src/a.ts" }, "y".repeat(12_000)),
      toolTurn("update_plan", { items: [] }),
      toolTurn("run_command", { command: "true" }),
      toolTurn("run_command", { command: "true" }),
      toolTurn("run_command", { command: "true" }),
      response({ content: "done" }),
      // The finalize gate asks once about the unfinished plan item.
      response({ content: "done, the last step is left for later" }),
    ]);
    const plan = [
      { step: "Read a", status: "done" },
      { step: "Edit a", status: "in_progress", activeForm: "Editing a" },
    ];
    const agent = createAgentCore({
      provider,
      dispatcher: scriptedDispatcher({
        read_file: () => ({ ok: true, data: { content: "stale" }, meta: { path: "src/a.ts" } }),
        update_plan: () => ({ ok: true, data: { items: plan } }),
      }),
      confirm: async () => true,
      contextWindowTokens: 20_000,
      // Budget 7808: compaction starts at ~2000 tokens, once enough turns exist to drop one.
      autoCompactThreshold: 0.26,
    });
    const events = await collect(agent.runTask(input()));
    expect(events.at(-1)).toMatchObject({ type: "session.completed" });
    const compacted = events.findIndex((e) => e.type === "context.compacted");
    expect(compacted).toBeGreaterThan(-1);

    const restored = provider.requests
      .flatMap((req) => req.messages)
      .find((m) => m.role === "user" && m.content.startsWith("[harness] The conversation was compacted"));
    expect(restored).toBeDefined();
    expect(restored!.content).toContain("- [x] Read a\n- [~] Edit a");
    expect(restored!.content).toContain('<file path="src/a.ts">\nexport const fromDisk = 1;\n');
    expect(restored!.content).not.toContain("stale");
    // Harness context is transient: nothing of it reaches the durable trace.
    const stored = loadSessionMessages(workspace, (events[0] as { sessionId: string }).sessionId);
    expect(stored.some((m) => m.content.startsWith("[harness]"))).toBe(false);
  });
});

describe("background task notices", () => {
  it("tells the model once, at the next turn boundary, when a background command exits", async () => {
    const background = createBackgroundTasks();
    try {
      const provider = fakeProvider([
        toolTurn("run_command", { command: "true", background: true }),
        toolTurn("read_file", { path: "a.ts" }),
        response({ content: "done" }),
      ]);
      const agent = createAgentCore({
        provider,
        dispatcher: scriptedDispatcher({
          run_command: async (_call, ctx) => {
            const { id } = ctx.background!.start({ command: "exit 2", cwd: workspace, owner: ctx.sessionId });
            // A task another session owns is never announced here.
            ctx.background!.start({ command: "true", cwd: workspace, owner: "someone-else" });
            const deadline = Date.now() + 5_000;
            while (ctx.background!.get(id)!.status !== "exited" && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return { ok: true, data: { taskId: id } };
          },
        }),
        confirm: async () => true,
        background,
      });
      const events = await collect(agent.runTask(input()));
      expect(events.at(-1)?.type).toBe("session.completed");

      const harness = (req: ChatRequest) =>
        req.messages.filter((m) => m.role === "user" && m.content.startsWith("[harness] Background task update"));
      expect(harness(provider.requests[0]!)).toHaveLength(0);
      expect(harness(provider.requests[1]!).map((m) => m.content)).toEqual([
        '[harness] Background task update:\n- bg-1 exited with code 2: "exit 2" — read its output with task_output (taskId "bg-1").',
      ]);
      // Told once: the note is not added again on the next turn.
      expect(harness(provider.requests[2]!)).toHaveLength(1);
      expect(events.filter((e) => e.type === "notice").map((e) => (e as { message: string }).message)).toEqual([
        "Background task bg-1 exited with code 2: exit 2",
      ]);
    } finally {
      background.disposeAll();
    }
  });
});

describe("changed-file tracking", () => {
  it("reports notebook, LSP and shell-detected changes like any other edit", async () => {
    const provider = fakeProvider([
      toolTurn("notebook_edit", { path: "nb.ipynb", cellIndex: 0, mode: "delete" }),
      toolTurn("lsp_rename", { path: "a.ts", line: 1, newName: "b" }),
      toolTurn("run_command", { command: "make generate" }),
      response({ content: "done" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: scriptedDispatcher({
        notebook_edit: () => ({ ok: true, meta: { path: "nb.ipynb", permission: "write" } }),
        lsp_rename: () => ({
          ok: true,
          data: {
            files: [
              { path: "a.ts", edits: 1 },
              { path: "b.ts", edits: 2 },
            ],
          },
          meta: { path: "a.ts", permission: "write" },
        }),
        run_command: (_call, ctx) => {
          ctx.checkpoint?.("gen/out.txt", null, { source: "shell", command: "make generate" });
          return { ok: true, data: { exitCode: 0 }, meta: { permission: "execute", command: "make generate" } };
        },
      }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask(input()));
    const changed = events.filter((e) => e.type === "file.changed").map((e) => (e as { path: string }).path);
    expect(changed).toEqual(["nb.ipynb", "a.ts", "b.ts", "gen/out.txt"]);
    const done = events.at(-1);
    expect(done?.type === "session.completed" ? done.report.changedFiles : []).toEqual(changed);

    const sessionId = (events[0] as { sessionId: string }).sessionId;
    expect(readCheckpoints(workspace, sessionId)).toEqual([
      expect.objectContaining({ path: "gen/out.txt", before: null, source: "shell", command: "make generate" }),
    ]);
  });
});

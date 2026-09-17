import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createDispatcher, defineTool, type ToolDispatcher } from "../../src/tools/index.js";
import { MAX_STOP_HOOK_CONTINUATIONS } from "../../src/hooks/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { createSessionTrace } from "../../src/agent/trace.js";
import type { AgentDefinition } from "../../src/subagents/index.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

/** Scripted provider that records every request. */
function recordingProvider(script: ChatResponse[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest) => {
    requests.push(req);
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", requests, chat: next, chatStream: (req) => next(req) };
}

function toolCall(id: string, name: string, args: unknown): ChatResponse {
  return response({
    toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }],
    finishReason: "tool_calls",
  });
}

/** A read-only tool that records its runs. */
function probeDispatcher(): ToolDispatcher & { runs: string[] } {
  const runs: string[] = [];
  const dispatcher = createDispatcher([
    defineTool({
      name: "probe",
      description: "test probe",
      schema: z.object({ target: z.string() }),
      classify: (args) => ({ permission: "readonly", description: "probe", path: args.target }),
      async run(args) {
        runs.push(args.target);
        return { data: { probed: args.target } };
      },
    }),
    defineTool({
      name: "edit_probe",
      description: "test write",
      schema: z.object({ target: z.string() }),
      classify: (args) => ({ permission: "write", description: "edit probe", path: args.target }),
      async run(args) {
        runs.push(`edit:${args.target}`);
        return { data: { edited: args.target } };
      },
    }),
  ]);
  return Object.assign(dispatcher, { runs });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const json = (value: unknown): string => `printf '%s' '${JSON.stringify(value)}'`;
const notices = (events: AgentEvent[]): string[] => events.flatMap((e) => (e.type === "notice" ? [e.message] : []));

describe("agent loop: deeper hooks", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-loopdepth-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do it", mode: "edit" as const, approvalMode: "auto" as const };

  it("injects sessionStart JSON additionalContext (not its plain stdout) before userPromptSubmit context", async () => {
    const provider = recordingProvider([response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      hooks: {
        sessionStart: [{ command: "echo starting up" }, { command: json({ additionalContext: "on branch <main>" }) }],
        userPromptSubmit: [{ command: "echo prompt ctx" }],
      },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const user = (provider.requests[0]!.messages as ChatMessage[]).find((m) => m.role === "user")!;
    expect(user.content).toBe(
      "do it" +
        "\n\n<hook-context>\non branch &lt;main&gt;\n</hook-context>" +
        "\n\n<hook-context>\nprompt ctx\n</hook-context>",
    );
  });

  it("a stop hook's block keeps the run going with its reason, then lets it finish", async () => {
    const provider = recordingProvider([response({ content: "first answer" }), response({ content: "final answer" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      hooks: {
        stop: [
          {
            // Block only while no earlier stop hook has (the stopHookActive guard).
            command:
              'input=$(cat); echo "$input" >> stops.jsonl; case "$input" in *\'"stopHookActive":true\'*) exit 0;; esac; ' +
              json({ decision: "block", reason: "run the tests first" }),
          },
        ],
      },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const completed = events.find((e) => e.type === "session.completed");
    expect(completed).toMatchObject({ report: { summary: "final answer" } });
    const stops = readFileSync(join(workspace, "stops.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(stops.map((s) => [s.summary, s.stopHookActive])).toEqual([
      ["first answer", false],
      ["final answer", true],
    ]);
    const second = provider.requests[1]!.messages as ChatMessage[];
    expect(second.at(-2)).toMatchObject({ role: "assistant", content: "first answer" });
    expect(second.at(-1)!.content).toContain("A stop hook configured by the user asked you to keep working");
    expect(second.at(-1)!.content).toContain("<hook-context>\nrun the tests first\n</hook-context>");
    expect(notices(events)).toContain("stop hook: run the tests first");
    // The stop fires before completion, not after it.
    const types = events.map((e) => e.type);
    expect(types.indexOf("session.completed")).toBe(types.length - 1);
  });

  it("caps stop-hook continuations per run", async () => {
    const provider = recordingProvider(
      Array.from({ length: MAX_STOP_HOOK_CONTINUATIONS + 1 }, (_, i) => response({ content: `answer ${i}` })),
    );
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      hooks: { stop: [{ command: `echo x >> stops.txt; ${json({ decision: "block", reason: "again" })}` }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(readFileSync(join(workspace, "stops.txt"), "utf8").trim().split("\n")).toHaveLength(
      MAX_STOP_HOOK_CONTINUATIONS + 1,
    );
    expect(notices(events).some((n) => n.includes("finishing anyway"))).toBe(true);
  });

  it("continue:false from any stop hook wins over a block, and its stopReason is shown", async () => {
    const provider = recordingProvider([response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      hooks: {
        stop: [
          { command: json({ decision: "block", reason: "more" }) },
          { command: json({ continue: false, stopReason: "stopping for the night" }) },
        ],
      },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(notices(events)).toContain("stopping for the night");
  });

  it("appends postToolUse context beside the tool result the model reads and records", async () => {
    const provider = recordingProvider([toolCall("c1", "probe", { target: "a.ts" }), response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      hooks: { postToolUse: [{ command: json({ additionalContext: "a.ts is generated; edit a.src" }) }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const tool = (provider.requests[1]!.messages as ChatMessage[]).find((m) => m.role === "tool")!;
    expect(tool.content).toBe(
      '{"ok":true,"data":{"probed":"a.ts"}}' +
        "\n\n[harness] Output of the user's hooks for this call (not part of the tool result):" +
        "\n\n<hook-context>\na.ts is generated; edit a.src\n</hook-context>",
    );
    expect(notices(events)).toContain("postToolUse hook: a.ts is generated; edit a.src");
    const created = events.find((e) => e.type === "session.created") as Extract<
      AgentEvent,
      { type: "session.created" }
    >;
    const traced = readFileSync(join(workspace, ".seekforge", "sessions", created.sessionId, "messages.jsonl"), "utf8");
    expect(traced).toContain("a.ts is generated; edit a.src");
  });

  it("a tool-stage continue:false ends the run after recording that turn's results", async () => {
    const dispatcher = probeDispatcher();
    const provider = recordingProvider([
      response({
        toolCalls: [
          { id: "c1", name: "probe", argumentsJson: '{"target":"a.ts"}' },
          { id: "c2", name: "probe", argumentsJson: '{"target":"b.ts"}' },
        ],
        finishReason: "tool_calls",
      }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      hooks: { postToolUse: [{ command: json({ continue: false, stopReason: "quota reached" }) }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(dispatcher.runs).toEqual(["a.ts"]);
    const completions = events.filter((e) => e.type === "tool.completed") as Extract<
      AgentEvent,
      { type: "tool.completed" }
    >[];
    expect(completions.map((c) => c.result.error?.code ?? "ok")).toEqual(["ok", "stopped_by_hook"]);
    const failed = events.find((e) => e.type === "session.failed") as Extract<AgentEvent, { type: "session.failed" }>;
    expect(failed.error).toMatchObject({ code: "stopped_by_hook", message: "quota reached" });
    expect(notices(events)).toContain("quota reached");
  });

  it("evaluates prompt hooks with the run's provider and counts their tokens", async () => {
    const provider = recordingProvider([response({ content: '{"ok": true}' }), response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      hooks: { userPromptSubmit: [{ type: "prompt", prompt: "Is this task in scope? $ARGUMENTS" }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect((provider.requests[0]!.messages as ChatMessage[])[1]!.content).toContain('"task":"do it"');
    const completed = events.find((e) => e.type === "session.completed") as Extract<
      AgentEvent,
      { type: "session.completed" }
    >;
    expect(completed.report.usage.promptTokens).toBe(2 * USAGE.promptTokens);
  });

  it("a prompt hook's refusal blocks the run on userPromptSubmit", async () => {
    const provider = recordingProvider([response({ content: '{"ok": false, "reason": "out of scope"}' })]);
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      hooks: { userPromptSubmit: [{ type: "prompt", prompt: "In scope?" }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const failed = events.find((e) => e.type === "session.failed") as Extract<AgentEvent, { type: "session.failed" }>;
    expect(failed.error).toMatchObject({ code: "blocked_by_hook", message: "out of scope" });
  });

  it("a permissionRequest answer replaces the prompt, so notification does not fire", async () => {
    let prompted = 0;
    const agent = createAgentCore({
      provider: recordingProvider([toolCall("c1", "edit_probe", { target: "a.ts" }), response({ content: "done" })]),
      dispatcher: probeDispatcher(),
      confirm: async () => {
        prompted++;
        return true;
      },
      hooks: {
        permissionRequest: [{ command: json({ hookSpecificOutput: { decision: { behavior: "allow" } } }) }],
        notification: [{ command: "touch notified" }],
      },
    });
    await collect(agent.runTask({ ...baseInput, approvalMode: "confirm", projectPath: workspace }));
    expect(prompted).toBe(0);
    expect(existsSync(join(workspace, "notified"))).toBe(false);
  });

  it("fires postCompact after automatic compaction", async () => {
    const trace = createSessionTrace(workspace, "s-compact");
    trace.message({ role: "system", content: "sys" });
    for (let i = 1; i <= 3; i++) {
      trace.message({ role: "user", content: `turn ${i}` });
      trace.message({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "probe", argumentsJson: "{}" }],
      });
      trace.message({ role: "tool", content: "x".repeat(3_000), toolCallId: `c${i}` });
      trace.message({ role: "assistant", content: `ok ${i}` });
    }
    const agent = createAgentCore({
      provider: recordingProvider([response({ content: "done" })]),
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      contextWindowTokens: 11_000,
      hooks: {
        preCompact: [{ command: "echo pre >> order.txt" }],
        postCompact: [{ command: `cat > post.json; echo post >> order.txt; ${json({ systemMessage: "compacted!" })}` }],
      },
    });
    const events = await collect(
      agent.runTask({
        ...{ task: "turn 4", mode: "edit" as const, approvalMode: "auto" as const },
        projectPath: workspace,
        resumeSessionId: "s-compact",
        systemPromptOverride: "sys",
      }),
    );
    expect(readFileSync(join(workspace, "order.txt"), "utf8")).toBe("pre\npost\n");
    const post = JSON.parse(readFileSync(join(workspace, "post.json"), "utf8"));
    expect(post).toMatchObject({ stage: "postCompact", reason: "auto" });
    expect(post.droppedTurns).toBeGreaterThan(0);
    expect(notices(events)).toContain("compacted!");
  });
});

describe("agent loop: subagent hooks", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-subhooks-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const fixer: AgentDefinition = {
    id: "fixer",
    name: "Fixer",
    description: "fixes bugs",
    triggers: [],
    mode: "edit",
    scope: "project",
  };

  const dispatch = (task: string) => toolCall("d1", "dispatch_agent", { agentId: "fixer", task });

  it("subagentStart sees the agent and task, and its context reaches the subagent's task", async () => {
    const provider = recordingProvider([
      dispatch("fix the parser"),
      response({ content: "sub done" }),
      response({ content: "ok" }),
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher: probeDispatcher(),
      confirm: async () => true,
      subagents: [fixer],
      hooks: {
        subagentStart: [
          { match: "fixer", command: `cat > start.json; ${json({ additionalContext: "parser lives in src/p.ts" })}` },
          { match: "reviewer", command: "touch wrong-agent" },
        ],
      },
    });
    const events = await collect(
      agent.runTask({ task: "go", mode: "edit", approvalMode: "auto", projectPath: workspace }),
    );
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(JSON.parse(readFileSync(join(workspace, "start.json"), "utf8"))).toMatchObject({
      stage: "subagentStart",
      agentId: "fixer",
      task: "fix the parser",
    });
    expect(existsSync(join(workspace, "wrong-agent"))).toBe(false);
    const nestedUser = (provider.requests[1]!.messages as ChatMessage[]).find((m) => m.role === "user")!;
    expect(nestedUser.content).toBe("fix the parser\n\n<hook-context>\nparser lives in src/p.ts\n</hook-context>");
  });

  it("a permissionRequest hook can refuse a dispatch prompt for the user", async () => {
    let prompted = 0;
    const agent = createAgentCore({
      provider: recordingProvider([dispatch("go fix"), response({ content: "ok" })]),
      dispatcher: probeDispatcher(),
      confirm: async () => {
        prompted++;
        return true;
      },
      subagents: [fixer],
      hooks: {
        permissionRequest: [
          { command: `cat > perm.json; ${json({ decision: "deny", reason: "no subagents today" })}` },
        ],
      },
    });
    const events = await collect(
      agent.runTask({ task: "go", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );
    expect(prompted).toBe(0);
    const done = events.find((e) => e.type === "tool.completed" && e.toolName === "dispatch_agent") as Extract<
      AgentEvent,
      { type: "tool.completed" }
    >;
    expect(done.result.error).toEqual({
      code: "hook_blocked",
      message: "Blocked by permissionRequest hook: no subagents today",
    });
    expect(JSON.parse(readFileSync(join(workspace, "perm.json"), "utf8"))).toMatchObject({
      stage: "permissionRequest",
      toolName: "dispatch_agent",
      permission: "write",
      args: { agentId: "fixer", task: "go fix" },
    });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  ChatResponse,
  ConfirmResult,
  PermissionRequest,
  ToolCall,
  ToolResult,
} from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { EXIT_PLAN_MODE_TOOL } from "../../src/agent/plan-mode.js";
import { readSessionMeta } from "../../src/agent/trace.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };
const PLAN = "## Plan\n1. Edit src/a.ts\n## Verification\npnpm test";

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

let callSeq = 0;
function toolTurn(name: string, args: unknown): ChatResponse {
  return response({
    toolCalls: [{ id: `call-${++callSeq}`, name, argumentsJson: JSON.stringify(args) }],
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

type Seen = { name: string; mode: string; approvalMode: string };

function recordingDispatcher(): ToolDispatcher & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    list: () => ["read_file", "write_file"].map((name) => ({ name, description: "d", parameters: {} })),
    execute: async (call: ToolCall, ctx): Promise<ToolResult> => {
      seen.push({ name: call.name, mode: ctx.policy.mode, approvalMode: ctx.policy.approvalMode });
      return { ok: true };
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const toolNames = (req: ChatRequest | undefined) => (req?.tools ?? []).map((tool) => tool.name);
const completedResult = (events: AgentEvent[], name: string): ToolResult | undefined => {
  const event = events.find((e) => e.type === "tool.completed" && e.toolName === name);
  return event?.type === "tool.completed" ? event.result : undefined;
};

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "seekforge-exit-plan-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const planInput = () => ({
  projectPath: workspace,
  task: "plan the change",
  mode: "ask" as const,
  plan: true,
  approvalMode: "confirm" as const,
});

function confirmer(answer: (req: PermissionRequest) => ConfirmResult) {
  const requests: PermissionRequest[] = [];
  return {
    requests,
    confirm: async (req: PermissionRequest): Promise<ConfirmResult> => {
      requests.push(req);
      return answer(req);
    },
  };
}

describe("exit_plan_mode", () => {
  it("is offered only to plan runs", async () => {
    const plain = fakeProvider([response({ content: "answer" })]);
    await collect(
      createAgentCore({ provider: plain, dispatcher: recordingDispatcher(), confirm: async () => true }).runTask({
        ...planInput(),
        plan: false,
      }),
    );
    expect(toolNames(plain.requests[0])).not.toContain(EXIT_PLAN_MODE_TOOL);

    const planning = fakeProvider([response({ content: PLAN })]);
    await collect(
      createAgentCore({ provider: planning, dispatcher: recordingDispatcher(), confirm: async () => true }).runTask(
        planInput(),
      ),
    );
    expect(toolNames(planning.requests[0])).toContain(EXIT_PLAN_MODE_TOOL);
    expect(planning.requests[0]!.messages[0]!.content).toContain("exit_plan_mode");
  });

  it("on approval switches the same run to edit mode and keeps going", async () => {
    const planProvider = fakeProvider([toolTurn(EXIT_PLAN_MODE_TOOL, { plan: PLAN })], "claude-opus-5");
    const main = fakeProvider([
      toolTurn("write_file", { path: "src/a.ts", content: "x" }),
      response({ content: "done" }),
    ]);
    const dispatcher = recordingDispatcher();
    const approval = confirmer(() => true);
    const agent = createAgentCore({
      provider: main,
      providerForModel: () => planProvider,
      planModel: "claude-opus-5",
      dispatcher,
      confirm: approval.confirm,
    });
    const events = await collect(agent.runTask(planInput()));
    expect(events.at(-1)?.type).toBe("session.completed");

    // The approval went through the ordinary confirm channel with the plan raw.
    expect(approval.requests).toEqual([
      expect.objectContaining({
        toolName: EXIT_PLAN_MODE_TOOL,
        permission: "write",
        preview: { path: "plan", diff: PLAN },
        sessionGrantable: false,
      }),
    ]);
    expect(approval.requests[0]!.description).toContain(PLAN);
    expect(approval.requests[0]!.rememberRule).toBeUndefined();
    expect(completedResult(events, EXIT_PLAN_MODE_TOOL)).toMatchObject({ ok: true, data: { approved: true } });
    expect(events).toContainEqual({
      type: "notice",
      level: "info",
      message: "Plan approved — continuing in edit mode.",
    });

    // Planning happened on the plan model; execution is back on the main one,
    // with the edit-mode prompt, without the exit tool, and with the user's
    // approval mode untouched.
    expect(planProvider.requests).toHaveLength(1);
    expect(main.requests).toHaveLength(2);
    expect(main.requests[0]!.messages[0]!.content).toContain("Mode: EDIT");
    expect(main.requests[0]!.messages[0]!.content).not.toContain("Mode: PLAN");
    expect(toolNames(main.requests[0])).not.toContain(EXIT_PLAN_MODE_TOOL);
    expect(dispatcher.seen).toEqual([{ name: "write_file", mode: "edit", approvalMode: "confirm" }]);

    const sessionId = (events[0] as { sessionId: string }).sessionId;
    expect(readSessionMeta(workspace, sessionId)).toMatchObject({ mode: "edit", status: "completed" });
  });

  it("on a refusal with feedback stays in plan mode and returns the feedback", async () => {
    const provider = fakeProvider([
      toolTurn(EXIT_PLAN_MODE_TOOL, { plan: PLAN }),
      toolTurn("read_file", { path: "src/a.ts" }),
      response({ content: PLAN }),
    ]);
    const dispatcher = recordingDispatcher();
    const approval = confirmer(() => ({ allow: false, feedback: "  cover the error path too  " }));
    const events = await collect(
      createAgentCore({ provider, dispatcher, confirm: approval.confirm }).runTask(planInput()),
    );
    expect(events.at(-1)?.type).toBe("session.completed");
    const result = completedResult(events, EXIT_PLAN_MODE_TOOL);
    expect(result).toMatchObject({ ok: false, error: { code: "denied_by_user" } });
    expect(result?.error?.message).toContain("said: cover the error path too.");
    // Still offered, so the model can revise and resubmit.
    expect(toolNames(provider.requests[1])).toContain(EXIT_PLAN_MODE_TOOL);
    expect(dispatcher.seen).toEqual([{ name: "read_file", mode: "ask", approvalMode: "confirm" }]);
    const sessionId = (events[0] as { sessionId: string }).sessionId;
    expect(readSessionMeta(workspace, sessionId)?.mode).toBe("ask");
  });

  it("on a bare refusal (or a host that cannot ask) retires the tool for the run", async () => {
    const provider = fakeProvider([toolTurn(EXIT_PLAN_MODE_TOOL, { plan: PLAN }), response({ content: PLAN })]);
    const events = await collect(
      createAgentCore({ provider, dispatcher: recordingDispatcher(), confirm: async () => false }).runTask(planInput()),
    );
    expect(events.at(-1)?.type).toBe("session.completed");
    expect(completedResult(events, EXIT_PLAN_MODE_TOOL)?.error?.message).toContain("no longer available");
    expect(toolNames(provider.requests[1])).not.toContain(EXIT_PLAN_MODE_TOOL);
    expect(provider.requests[1]!.messages[0]!.content).toContain("Mode: PLAN");
  });

  it("rejects an empty plan without asking anyone", async () => {
    const provider = fakeProvider([toolTurn(EXIT_PLAN_MODE_TOOL, { plan: "  " }), response({ content: PLAN })]);
    const approval = confirmer(() => true);
    const events = await collect(
      createAgentCore({ provider, dispatcher: recordingDispatcher(), confirm: approval.confirm }).runTask(planInput()),
    );
    expect(approval.requests).toEqual([]);
    expect(completedResult(events, EXIT_PLAN_MODE_TOOL)).toMatchObject({
      ok: false,
      error: { code: "invalid_args" },
    });
  });

  it("is refused like any unadvertised tool outside plan mode", async () => {
    const provider = fakeProvider([toolTurn(EXIT_PLAN_MODE_TOOL, { plan: PLAN }), response({ content: "done" })]);
    const approval = confirmer(() => true);
    const events = await collect(
      createAgentCore({ provider, dispatcher: recordingDispatcher(), confirm: approval.confirm }).runTask({
        ...planInput(),
        mode: "edit",
        plan: false,
      }),
    );
    expect(approval.requests).toEqual([]);
    expect(completedResult(events, EXIT_PLAN_MODE_TOOL)).toMatchObject({
      ok: false,
      error: { code: "tool_not_advertised" },
    });
  });
});

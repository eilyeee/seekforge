import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@seekforge/shared";
import { createAgentCore } from "../../src/agent/loop.js";
import type { AgentDefinition } from "../../src/subagents/index.js";
import {
  collect,
  deferred,
  fakeDispatcher,
  isParentRequest,
  response,
  routedProvider,
  toolCall,
  toolCallsResponse,
  toolCompleted,
} from "./helpers.js";

const alpha: AgentDefinition = {
  id: "alpha",
  name: "Alpha",
  description: "agent a",
  triggers: [],
  mode: "ask",
  scope: "project",
};
const beta: AgentDefinition = { ...alpha, id: "beta", name: "Beta", description: "agent b" };

describe("parallel dispatch (same-turn fan-out)", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-parallel-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do the thing", mode: "edit" as const, approvalMode: "confirm" as const };

  it("runs two dispatch calls from one turn concurrently, results in call order", async () => {
    const order: string[] = [];
    // alpha can only finish after the parent loop has SEEN beta's completion:
    // sequential execution of the two dispatches would deadlock here.
    const alphaGate = deferred<void>();
    let parentRequests = 0;

    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        parentRequests++;
        if (parentRequests === 1) {
          return toolCallsResponse(
            toolCall("d1", "dispatch_agent", { agentId: "alpha", task: "task-alpha" }),
            toolCall("d2", "dispatch_agent", { agentId: "beta", task: "task-beta" }),
          );
        }
        return response({ content: "done" });
      }
      if (req.messages[0]!.content.includes("You are Alpha")) {
        order.push("alpha-started");
        await alphaGate.promise;
        order.push("alpha-finished");
        return response({ content: "alpha report" });
      }
      order.push("beta-started");
      order.push("beta-finished");
      return response({ content: "beta report" });
    });

    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [alpha, beta],
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.runTask({ ...baseInput, projectPath: workspace })) {
      events.push(ev);
      if (
        ev.type === "tool.completed" &&
        ev.toolName === "dispatch_agent" &&
        (ev.result.data as { agentId?: string } | undefined)?.agentId === "beta"
      ) {
        alphaGate.resolve();
      }
    }

    // Overlap: both nested runs started before either finished, and the
    // started order (alpha, beta) differs from the completion order (beta, alpha).
    expect(order.slice(0, 2)).toEqual(["alpha-started", "beta-started"]);
    expect(order.indexOf("beta-finished")).toBeLessThan(order.indexOf("alpha-finished"));

    // Completion events arrive in completion order (beta first) ...
    const completions = toolCompleted(events, "dispatch_agent");
    expect(completions).toHaveLength(2);
    expect((completions[0]!.result.data as { agentId: string }).agentId).toBe("beta");
    expect((completions[1]!.result.data as { agentId: string }).agentId).toBe("alpha");
    expect(completions.every((c) => c.result.ok)).toBe(true);

    // ... but both results are correct and complete
    expect(completions.find((c) => (c.result.data as { agentId: string }).agentId === "alpha")!.result.data).toEqual({
      agentId: "alpha",
      report: "alpha report",
      changedFiles: [],
      commandsRun: [],
    });

    // Tool messages are appended in the ORIGINAL toolCalls order (d1, d2).
    const secondParentReq = provider.requests.filter(isParentRequest)[1]!;
    const toolMsgs = secondParentReq.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["d1", "d2"]);
    expect(toolMsgs[0]!.content).toContain("alpha report");
    expect(toolMsgs[1]!.content).toContain("beta report");

    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("a dispatch and a regular tool call in one turn: tool runs sequentially, messages stay in order", async () => {
    let parentRequests = 0;
    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        parentRequests++;
        if (parentRequests === 1) {
          return toolCallsResponse(
            toolCall("d1", "dispatch_agent", { agentId: "alpha", task: "task-alpha" }),
            toolCall("t1", "read_file", { path: "a.ts" }),
          );
        }
        return response({ content: "done" });
      }
      return response({ content: "alpha report" });
    });
    const dispatcher = fakeDispatcher();
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      subagents: [alpha],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    expect(dispatcher.calls.map((c) => c.call.name)).toEqual(["read_file"]);
    const secondParentReq = provider.requests.filter(isParentRequest)[1]!;
    const toolMsgs = secondParentReq.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["d1", "t1"]);
    expect(toolMsgs[0]!.content).toContain("alpha report");
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });
});

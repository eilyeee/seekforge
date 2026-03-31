import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest, ToolResult } from "@seekforge/shared";
import type { ChatRequest } from "../../src/provider/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { createDispatchManager, type DispatchManager } from "../../src/subagents/manager.js";
import type { AgentDefinition } from "../../src/subagents/index.js";
import {
  collect,
  fakeDispatcher,
  isParentRequest,
  response,
  routedProvider,
  toolCall,
  toolCallsResponse,
  toolCompleted,
} from "./helpers.js";

const helper: AgentDefinition = {
  id: "helper",
  name: "Helper",
  description: "helps out",
  triggers: [],
  mode: "ask",
  scope: "project",
};

const fixer: AgentDefinition = { ...helper, id: "fixer", name: "Fixer", description: "fixes bugs", mode: "edit" };

/** Registers a completed dispatch of `agentId` as ag-1 in a fresh manager. */
async function seededManager(agentId: string): Promise<DispatchManager> {
  const manager = createDispatchManager();
  const seeded: ToolResult = {
    ok: true,
    data: { agentId, report: "seed report", changedFiles: [], commandsRun: [] },
  };
  await manager.start({
    agentId,
    task: "seed task",
    run: async (_signal, hooks) => {
      hooks.onSubSession("seed-session");
      return seeded;
    },
  }).promise;
  return manager;
}

describe("agent_send (dispatch continuation)", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-send-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do the thing", mode: "edit" as const, approvalMode: "confirm" as const };

  it("continues a completed dispatch with its prior context", async () => {
    let parentRequests = 0;
    let resumedRequest: ChatRequest | undefined;

    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        parentRequests++;
        switch (parentRequests) {
          case 1:
            return toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: "helper", task: "first task" }));
          case 2:
            return toolCallsResponse(toolCall("s1", "agent_send", { dispatchId: "ag-1", task: "follow up" }));
          default:
            return response({ content: "done" });
        }
      }
      // nested helper run: fresh dispatch, then the resumed continuation
      if (!req.messages.some((m) => m.content === "follow up")) {
        return response({ content: "first report" });
      }
      resumedRequest = req;
      return response({ content: "second report" });
    });

    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [helper],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // agent_send returned like a dispatch result
    const [sendDone] = toolCompleted(events, "agent_send");
    expect(sendDone!.result.ok).toBe(true);
    expect(sendDone!.result.data).toEqual({
      agentId: "helper",
      report: "second report",
      changedFiles: [],
      commandsRun: [],
    });

    // The resumed run replayed the prior session: subagent system prompt,
    // original task, prior report, then the follow-up as the latest message.
    expect(resumedRequest).toBeDefined();
    const msgs = resumedRequest!.messages;
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("You are Helper (helper)");
    expect(msgs.some((m) => m.role === "user" && m.content === "first task")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "first report")).toBe(true);
    expect(msgs.at(-1)!.content).toBe("follow up");
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("returns dispatch_busy while the dispatch is still running", async () => {
    let parentRequests = 0;
    const provider = routedProvider((req) => {
      if (isParentRequest(req)) {
        parentRequests++;
        switch (parentRequests) {
          case 1:
            return toolCallsResponse(
              toolCall("d1", "dispatch_agent", { agentId: "helper", task: "long job", background: true }),
            );
          case 2:
            return toolCallsResponse(toolCall("s1", "agent_send", { dispatchId: "ag-1", task: "too early" }));
          default:
            return response({ content: "done" });
        }
      }
      return new Promise(() => {}); // nested run never finishes (aborted at session end)
    });
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [helper],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const [sendDone] = toolCompleted(events, "agent_send");
    expect(sendDone!.result.ok).toBe(false);
    expect(sendDone!.result.error!.code).toBe("dispatch_busy");
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("returns unknown_dispatch for an id that was never started", async () => {
    let parentRequests = 0;
    const provider = routedProvider(async () => {
      parentRequests++;
      return parentRequests === 1
        ? toolCallsResponse(toolCall("s1", "agent_send", { dispatchId: "ag-99", task: "hello" }))
        : response({ content: "done" });
    });
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [helper],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const [sendDone] = toolCompleted(events, "agent_send");
    expect(sendDone!.result.ok).toBe(false);
    expect(sendDone!.result.error!.code).toBe("unknown_dispatch");
  });

  it("read-only parent guard: agent_send to an edit-mode agent is refused in ask mode", async () => {
    const manager = await seededManager("fixer");
    let parentRequests = 0;
    const provider = routedProvider(async () => {
      parentRequests++;
      return parentRequests === 1
        ? toolCallsResponse(toolCall("s1", "agent_send", { dispatchId: "ag-1", task: "edit things" }))
        : response({ content: "ok" });
    });
    let confirmCalls = 0;
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => {
        confirmCalls++;
        return true;
      },
      subagents: [fixer],
      _dispatchManager: manager,
    });
    const events = await collect(agent.runTask({ ...baseInput, mode: "ask", projectPath: workspace }));
    const [sendDone] = toolCompleted(events, "agent_send");
    expect(sendDone!.result.ok).toBe(false);
    expect(sendDone!.result.error!.code).toBe("forbidden_in_ask_mode");
    expect(confirmCalls).toBe(0);
    expect(manager.get("ag-1")!.status).toBe("done"); // untouched
  });

  it("agent_send to an edit-mode agent goes through the approval flow", async () => {
    const manager = await seededManager("fixer");
    let parentRequests = 0;
    const provider = routedProvider(async () => {
      parentRequests++;
      return parentRequests === 1
        ? toolCallsResponse(toolCall("s1", "agent_send", { dispatchId: "ag-1", task: "more edits" }))
        : response({ content: "ok" });
    });
    const confirms: PermissionRequest[] = [];
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async (req) => {
        confirms.push(req);
        return false;
      },
      subagents: [fixer],
      _dispatchManager: manager,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.toolName).toBe("agent_send");
    expect(confirms[0]!.permission).toBe("write");
    expect(confirms[0]!.description).toBe("Dispatch agent fixer: more edits");
    const [sendDone] = toolCompleted(events, "agent_send");
    expect(sendDone!.result.error!.code).toBe("denied_by_user");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import { createDispatchManager } from "../../src/subagents/manager.js";
import type { AgentDefinition } from "../../src/subagents/index.js";
import {
  collect,
  deferred,
  fakeDispatcher,
  isParentRequest,
  response,
  routedProvider,
  settle,
  toolCall,
  toolCallsResponse,
  toolCompleted,
} from "./helpers.js";

const worker: AgentDefinition = {
  id: "worker",
  name: "Worker",
  description: "does long jobs",
  triggers: [],
  mode: "ask",
  scope: "project",
};

const fixer: AgentDefinition = { ...worker, id: "fixer", name: "Fixer", description: "fixes bugs", mode: "edit" };

describe("background dispatch + agent_result", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-bg-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do the thing", mode: "edit" as const, approvalMode: "confirm" as const };

  it("background:true returns the dispatch id immediately; agent_result polls running then done", async () => {
    const nestedAskedAgain = deferred<void>(); // nested finished its tool call, is asking for turn 2
    const reportGate = deferred<void>();
    let parentRequests = 0;

    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        parentRequests++;
        switch (parentRequests) {
          case 1:
            return toolCallsResponse(
              toolCall("d1", "dispatch_agent", { agentId: "worker", task: "long job", background: true }),
            );
          case 2:
            // Poll only once the nested run has demonstrably progressed
            // (one tool call done) but is still running.
            await nestedAskedAgain.promise;
            return toolCallsResponse(toolCall("r1", "agent_result", { dispatchId: "ag-1" }));
          case 3:
            // Let the background run finish completely, then poll again.
            reportGate.resolve();
            await settle();
            await settle();
            return toolCallsResponse(toolCall("r2", "agent_result", { dispatchId: "ag-1" }));
          default:
            return response({ content: "done" });
        }
      }
      // nested worker run
      if (!req.messages.some((m) => m.role === "tool")) {
        return toolCallsResponse(toolCall("n1", "read_file", { path: "a.ts" }));
      }
      nestedAskedAgain.resolve();
      await reportGate.promise;
      return response({ content: "worker report" });
    });

    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [worker],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // The dispatch call itself returned immediately with the dispatch id.
    const [dispatchDone] = toolCompleted(events, "dispatch_agent");
    expect(dispatchDone!.result.ok).toBe(true);
    expect(dispatchDone!.result.data).toEqual({ dispatchId: "ag-1", agentId: "worker", status: "running" });

    // First poll: still running, with the steps so far.
    const polls = toolCompleted(events, "agent_result");
    expect(polls).toHaveLength(2);
    expect(polls[0]!.result.ok).toBe(true);
    expect(polls[0]!.result.data).toEqual({ status: "running", agentId: "worker", steps: ["read_file"] });

    // Second poll: done, with the report.
    expect(polls[1]!.result.ok).toBe(true);
    expect(polls[1]!.result.data).toEqual({
      status: "done",
      report: "worker report",
      changedFiles: [],
      commandsRun: [],
    });

    // Nested tool activity still surfaced as parent step events.
    expect(events.some((e) => e.type === "step.started" && e.title === "[worker] read_file")).toBe(true);
    expect(events).toContainEqual({
      type: "subagent.started",
      dispatchId: "ag-1",
      agentId: "worker",
      task: "long job",
      status: "running",
    });
    expect(events.some((e) => e.type === "subagent.step" && e.dispatchId === "ag-1" && e.toolName === "read_file"))
      .toBe(true);
    expect(events.some((e) => e.type === "subagent.completed" && e.dispatchId === "ag-1" && e.status === "done"))
      .toBe(true);
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("agent_result with an unknown id returns unknown_dispatch", async () => {
    let parentRequests = 0;
    const provider = routedProvider(async () => {
      parentRequests++;
      return parentRequests === 1
        ? toolCallsResponse(toolCall("r1", "agent_result", { dispatchId: "ag-42" }))
        : response({ content: "done" });
    });
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [worker],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const [poll] = toolCompleted(events, "agent_result");
    expect(poll!.result.ok).toBe(false);
    expect(poll!.result.error!.code).toBe("unknown_dispatch");
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("session end aborts a hung background dispatch", async () => {
    let parentRequests = 0;
    let nestedStarted = false;
    const provider = routedProvider((req) => {
      if (isParentRequest(req)) {
        parentRequests++;
        return parentRequests === 1
          ? toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: "worker", task: "hang", background: true }))
          : response({ content: "done" });
      }
      // nested run hangs in the provider forever (only the abort frees it)
      nestedStarted = true;
      return new Promise(() => {});
    });

    const manager = createDispatchManager();
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [worker],
      _dispatchManager: manager,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // The session completed without waiting for the background run ...
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(nestedStarted).toBe(true);

    // ... and session end (disposeAll) aborted it as a distinct cancellation.
    await settle();
    const snap = manager.get("ag-1")!;
    expect(snap.status).toBe("cancelled");
    expect(snap.result!.error!.code).toBe("subagent_cancelled");
  });

  it("keeps usage billed before a background dispatch is aborted", async () => {
    const nestedBilled = deferred<void>();
    let parentRequests = 0;
    let nestedRequests = 0;
    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        parentRequests++;
        if (parentRequests === 1) {
          return toolCallsResponse(
            toolCall("d1", "dispatch_agent", { agentId: "worker", task: "bill then hang", background: true }),
          );
        }
        await nestedBilled.promise;
        return response({ content: "done" });
      }
      nestedRequests++;
      if (nestedRequests === 1) {
        nestedBilled.resolve();
        return toolCallsResponse(toolCall("n1", "read_file", { path: "a.ts" }));
      }
      return new Promise(() => {});
    });

    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [worker],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const completed = events.find((event) => event.type === "session.completed");

    expect(completed && completed.type === "session.completed" && completed.report.usage.promptTokens).toBe(30);
  });

  it("read-only parent guard applies to background dispatches too", async () => {
    let parentRequests = 0;
    const provider = routedProvider(async () => {
      parentRequests++;
      return parentRequests === 1
        ? toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: "fixer", task: "edit stuff", background: true }))
        : response({ content: "ok" });
    });
    let confirmCalls = 0;
    const manager = createDispatchManager();
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
    const [done] = toolCompleted(events, "dispatch_agent");
    expect(done!.result.ok).toBe(false);
    expect(done!.result.error!.code).toBe("forbidden_in_ask_mode");
    expect(confirmCalls).toBe(0);
    expect(manager.list()).toEqual([]); // refused before registration
  });
});

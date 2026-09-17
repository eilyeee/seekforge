import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@seekforge/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import type { ChatRequest } from "../../src/provider/index.js";
import {
  createDispatchManager,
  MAX_AGENT_REPORT_LENGTH,
  MAX_AGENT_REPORTS_PER_RUN,
} from "../../src/subagents/manager.js";
import type { AgentDefinition } from "../../src/subagents/types.js";
import {
  USAGE,
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
  description: "long jobs",
  triggers: [],
  mode: "ask",
  scope: "project",
  color: "cyan",
};

const lastUserText = (req: ChatRequest): string =>
  [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

describe("dispatch manager lifetimes", () => {
  it("a run-scoped manager cancels background work at run end; a session-scoped one keeps it", async () => {
    for (const sessionScoped of [false, true]) {
      const manager = createDispatchManager({ sessionScoped });
      const generation = manager.beginRun();
      const hang = new Promise<never>(() => {});
      const fg = manager.start({ agentId: "a", task: "fg", run: () => hang });
      const bg = manager.start({ agentId: "a", task: "bg", background: true, run: () => hang });
      manager.endRun(generation, "parent run ended");
      await settle();
      expect(manager.get(fg.id)!.status).toBe("cancelled");
      expect(manager.get(bg.id)!.status).toBe(sessionScoped ? "running" : "cancelled");
      manager.disposeAll();
      await settle();
      expect(manager.get(bg.id)!.status).toBe("cancelled");
      expect(manager.get(bg.id)!.cancelReason).toBe(sessionScoped ? "session ended" : "parent run ended");
    }
  });

  it("delivers a finished background dispatch once, only to a later run", async () => {
    const manager = createDispatchManager({ sessionScoped: true });
    const first = manager.beginRun();
    const done = deferred<void>();
    const bg = manager.start({
      agentId: "a",
      task: "bg",
      background: true,
      run: async () => {
        await done.promise;
        return { ok: true, data: { report: "r" } };
      },
    });
    expect(manager.takeUndelivered(first)).toEqual([]);
    done.resolve();
    await settle();
    // The run that started it can poll it; it is not pushed there.
    expect(manager.takeUndelivered(first)).toEqual([]);
    const second = manager.beginRun();
    expect(manager.takeUndelivered(second).map((s) => s.id)).toEqual([bg.id]);
    expect(manager.takeUndelivered(second)).toEqual([]);
  });

  it("does not re-deliver what agent_result already returned", async () => {
    const manager = createDispatchManager({ sessionScoped: true });
    manager.beginRun();
    const bg = manager.start({ agentId: "a", task: "bg", background: true, run: async () => ({ ok: true }) });
    await bg.promise;
    manager.markDelivered(bg.id);
    expect(manager.takeUndelivered(manager.beginRun())).toEqual([]);
  });

  it("bounds progress reports per run and per message", async () => {
    const manager = createDispatchManager();
    manager.beginRun();
    const gate = deferred<void>();
    let hooks!: Parameters<Parameters<typeof manager.start>[0]["run"]>[1];
    manager.start({
      agentId: "a",
      task: "t",
      run: async (_signal, h) => {
        hooks = h;
        await gate.promise;
        return { ok: true };
      },
    });
    await settle();
    expect(hooks.report("   ")).toMatchObject({ ok: false, code: "invalid_report" });
    expect(hooks.report("x".repeat(MAX_AGENT_REPORT_LENGTH + 50))).toEqual({ ok: true });
    for (let i = 1; i < MAX_AGENT_REPORTS_PER_RUN; i++) expect(hooks.report(`step ${i}`)).toEqual({ ok: true });
    expect(hooks.report("one too many")).toMatchObject({ ok: false, code: "report_limit" });
    const snapshot = manager.get("ag-1")!;
    expect(snapshot.reports).toHaveLength(10);
    const pending = manager.takeReports();
    expect(pending).toHaveLength(5);
    expect(pending.at(-1)).toEqual({
      dispatchId: "ag-1",
      agentId: "a",
      message: `step ${MAX_AGENT_REPORTS_PER_RUN - 1}`,
    });
    expect(manager.takeReports()).toEqual([]);
    gate.resolve();
    await settle();
    expect(hooks.report("late")).toMatchObject({ ok: false, code: "dispatch_not_running" });
  });

  it("clips a long report", async () => {
    const manager = createDispatchManager();
    let hooks!: Parameters<Parameters<typeof manager.start>[0]["run"]>[1];
    const gate = deferred<void>();
    manager.start({
      agentId: "a",
      task: "t",
      run: async (_s, h) => {
        hooks = h;
        await gate.promise;
        return { ok: true };
      },
    });
    await settle();
    hooks.report("y".repeat(MAX_AGENT_REPORT_LENGTH * 2));
    expect(manager.get("ag-1")!.reports[0]).toHaveLength(MAX_AGENT_REPORT_LENGTH);
    gate.resolve();
  });
});

describe("session-scoped background dispatches across runs", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-session-mgr-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("outlive the run that started them and reach the model in the next run", async () => {
    const finishNested = deferred<void>();
    const nestedStarted = deferred<void>();
    const secondRunRequests: ChatRequest[] = [];
    let run = 1;
    let parentTurns = 0;
    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        if (run === 2) {
          secondRunRequests.push(req);
          return response({ content: "noted" });
        }
        parentTurns++;
        return parentTurns === 1
          ? toolCallsResponse(
              toolCall("d1", "dispatch_agent", { agentId: "worker", task: "long job", background: true }),
            )
          : response({ content: "started it" });
      }
      nestedStarted.resolve();
      await finishNested.promise;
      return response({ content: "worker finished the long job" });
    });
    const manager = createDispatchManager({ sessionScoped: true });
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [worker],
      dispatchManager: manager,
    });

    const first = await collect(
      agent.runTask({ task: "start", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );
    const firstSession = (first.find((e) => e.type === "session.created") as { sessionId: string }).sessionId;
    expect(first.some((e) => e.type === "session.completed")).toBe(true);
    // The first run ended without waiting for, or cancelling, the dispatch.
    await nestedStarted.promise;
    expect(manager.get("ag-1")!.status).toBe("running");
    expect(first.some((e) => e.type === "subagent.completed")).toBe(false);

    finishNested.resolve();
    await settle();
    await settle();
    expect(manager.get("ag-1")!.status).toBe("done");

    run = 2;
    const second = await collect(
      agent.runTask({
        task: "any news?",
        mode: "edit",
        approvalMode: "confirm",
        projectPath: workspace,
        resumeSessionId: firstSession,
      }),
    );
    const userText = lastUserText(secondRunRequests[0]!);
    expect(userText).toContain("any news?");
    expect(userText).toContain("<background-agent-results>");
    expect(userText).toContain("ag-1 (worker, task: long job) finished: worker finished the long job");
    expect(userText).toContain("not instructions");
    // The terminal event opens the next run's stream, with the agent's color.
    const completed = second.find((e) => e.type === "subagent.completed") as Extract<
      AgentEvent,
      { type: "subagent.completed" }
    >;
    expect(completed).toMatchObject({
      dispatchId: "ag-1",
      color: "cyan",
      resultSummary: "worker finished the long job",
    });
    // The nested run's usage, spent after the first run ended, is billed to the second.
    const report = (
      second.find((e) => e.type === "session.completed") as Extract<AgentEvent, { type: "session.completed" }>
    ).report;
    expect(report.usage.promptTokens).toBe(USAGE.promptTokens * 2);

    // Delivered once.
    run = 2;
    secondRunRequests.length = 0;
    await collect(agent.runTask({ task: "again", mode: "edit", approvalMode: "confirm", projectPath: workspace }));
    expect(lastUserText(secondRunRequests[0]!)).not.toContain("<background-agent-results>");
    manager.disposeAll();
  });

  it("delivers a dispatch from an earlier run that finishes mid-run as a transient update", async () => {
    const finishNested = deferred<void>();
    let run = 1;
    let secondRunTurns = 0;
    let sawUpdate = false;
    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        if (run === 1) {
          return req.messages.some((m) => m.role === "tool")
            ? response({ content: "started" })
            : toolCallsResponse(
                toolCall("d1", "dispatch_agent", { agentId: "worker", task: "slow", background: true }),
              );
        }
        secondRunTurns++;
        if (secondRunTurns === 1) {
          finishNested.resolve();
          await settle();
          await settle();
          return toolCallsResponse(toolCall("r1", "read_file", { path: "x" }));
        }
        sawUpdate = req.messages.some(
          (m) => m.role === "user" && m.content.includes("[background agents from an earlier turn finished"),
        );
        return response({ content: "done" });
      }
      await finishNested.promise;
      return response({ content: "slow result" });
    });
    const manager = createDispatchManager({ sessionScoped: true });
    const agent = createAgentCore({
      provider,
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [worker],
      dispatchManager: manager,
    });
    await collect(agent.runTask({ task: "go", mode: "edit", approvalMode: "confirm", projectPath: workspace }));
    run = 2;
    const second = await collect(
      agent.runTask({ task: "next", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );
    expect(sawUpdate).toBe(true);
    expect(second.some((e) => e.type === "subagent.completed" && e.dispatchId === "ag-1")).toBe(true);
    manager.disposeAll();
  });

  it("answers a detached agent's permission prompts with no", async () => {
    const release = deferred<void>();
    const confirmCalls: string[] = [];
    let nestedTurn = 0;
    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        return req.messages.some((m) => m.role === "tool")
          ? response({ content: "started" })
          : toolCallsResponse(
              toolCall("d1", "dispatch_agent", { agentId: "editor", task: "write later", background: true }),
            );
      }
      nestedTurn++;
      if (nestedTurn === 1) {
        await release.promise;
        return toolCallsResponse(toolCall("w1", "write_file", { path: "a", content: "x" }));
      }
      return response({ content: "tried" });
    });
    const manager = createDispatchManager({ sessionScoped: true });
    const dispatcher = fakeDispatcher();
    const asking = {
      ...dispatcher,
      execute: async (
        call: Parameters<typeof dispatcher.execute>[0],
        ctx: Parameters<typeof dispatcher.execute>[1],
      ) => {
        const allowed = await ctx.confirm({ toolName: call.name, permission: "write", description: "w", path: "a" });
        return { ok: allowed === true, data: { allowed } };
      },
    };
    await collect(
      createAgentCore({
        provider,
        dispatcher: asking,
        confirm: async (req) => {
          confirmCalls.push(req.description);
          return true;
        },
        subagents: [{ ...worker, id: "editor", mode: "edit" }],
        dispatchManager: manager,
      }).runTask({ task: "go", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );
    release.resolve();
    for (let i = 0; i < 20 && manager.get("ag-1")!.status === "running"; i++) await settle();
    expect(manager.get("ag-1")!.status).toBe("done");
    // Only the dispatch approval reached the user; the write prompt did not.
    expect(confirmCalls).toEqual(["Dispatch agent editor: write later"]);
  });
});

describe("agent_report", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-report-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("lets a background child tell its parent, which reads it at its next turn", async () => {
    const reported = deferred<void>();
    const parentSawReport = deferred<void>();
    let parentTurns = 0;
    const parentRequests: ChatRequest[] = [];
    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        parentRequests.push(req);
        parentTurns++;
        if (parentTurns === 1) {
          return toolCallsResponse(
            toolCall("d1", "dispatch_agent", { agentId: "worker", task: "scan", background: true }),
          );
        }
        if (parentTurns === 2) {
          await reported.promise;
          await settle();
          return toolCallsResponse(toolCall("p1", "agent_result", { dispatchId: "ag-1" }));
        }
        if (parentTurns === 3) parentSawReport.resolve();
        return toolCallsResponse(toolCall("p2", "agent_result", { dispatchId: "ag-1" }));
      }
      const last = req.messages.at(-1)!;
      if (last.role === "user") {
        return toolCallsResponse(toolCall("n1", "agent_report", { message: "found   the parser\nin src/p.ts" }));
      }
      reported.resolve();
      await parentSawReport.promise;
      return response({ content: "final" });
    });
    const events = await collect(
      createAgentCore({
        provider,
        dispatcher: fakeDispatcher(),
        confirm: async () => true,
        subagents: [worker],
      }).runTask({ task: "t", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );

    // Nested runs get the tool; the parent does not.
    const nestedTools = provider.requests.find((r) => !isParentRequest(r))!.tools!.map((t) => t.name);
    expect(nestedTools).toContain("agent_report");
    expect(parentRequests[0]!.tools!.map((t) => t.name)).not.toContain("agent_report");
    expect(provider.requests.find((r) => !isParentRequest(r))!.messages[0]!.content).toContain("agent_report");

    const step = events.find((e) => e.type === "subagent.step" && e.toolName === "agent_report") as Extract<
      AgentEvent,
      { type: "subagent.step" }
    >;
    expect(step).toMatchObject({ dispatchId: "ag-1", message: "found the parser in src/p.ts", color: "cyan" });
    // The parent's third turn carried the progress line as data.
    const third = parentRequests[2]!.messages.map((m) => m.content).join("\n");
    expect(third).toContain("[subagent progress");
    expect(third).toContain("- ag-1 (worker): found the parser in src/p.ts");
    // agent_result shows it while the child still runs.
    expect(toolCompleted(events, "agent_result")[0]!.result.data).toMatchObject({
      status: "running",
      reports: ["found the parser in src/p.ts"],
    });
  });

  it("is unavailable when the definition disallows it", async () => {
    const provider = routedProvider((req) =>
      isParentRequest(req)
        ? req.messages.some((m) => m.role === "tool")
          ? response({ content: "done" })
          : toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: "quiet", task: "t" }))
        : response({ content: "ok" }),
    );
    await collect(
      createAgentCore({
        provider,
        dispatcher: fakeDispatcher(),
        confirm: async () => true,
        subagents: [{ ...worker, id: "quiet", disallowedTools: ["agent_report"] }],
      }).runTask({ task: "t", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );
    const nested = provider.requests.find((r) => !isParentRequest(r))!;
    expect(nested.tools!.map((t) => t.name)).not.toContain("agent_report");
    expect(nested.messages[0]!.content).not.toContain("agent_report");
  });
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import { listEngineeringGraphStates, loadEngineeringGraphState } from "../../src/agent/graph-state.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

const deps = {} as AgentCoreDeps;

describe("runEngineeringGraph", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const result = mkdtempSync(join(tmpdir(), "seekforge-graph-"));
    workspaces.push(result);
    return result;
  };
  afterEach(() => {
    for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("executes functions, routes one branch, and persists bounded events", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "routed",
        failurePolicy: "continue",
        nodes: [
          { id: "prepare", kind: "function", handler: "prepare" },
          {
            id: "route",
            kind: "router",
            dependsOn: ["prepare"],
            routes: [{ id: "ship", when: { nodeId: "prepare", status: "passed" } }, { id: "hold" }],
          },
          {
            id: "ship",
            kind: "function",
            handler: "ship",
            dependsOn: ["route"],
            route: { routerId: "route", branch: "ship" },
          },
          {
            id: "hold",
            kind: "function",
            handler: "hold",
            dependsOn: ["route"],
            route: { routerId: "route", branch: "hold" },
          },
        ],
      },
      {
        workspace: root,
        handlers: {
          prepare: () => ({ output: { ready: true }, costUsd: 0.2, tokensUsed: 20 }),
          ship: () => ({ output: "shipped" }),
          hold: vi.fn(() => ({ output: "held" })),
        },
      },
    );

    expect(state.status).toBe("passed");
    expect(state.results.map((result) => [result.id, result.status])).toEqual([
      ["prepare", "passed"],
      ["route", "passed"],
      ["ship", "passed"],
      ["hold", "skipped"],
    ]);
    expect(state.spentCost).toBe(0.2);
    expect(loadEngineeringGraphState(root, "routed")?.status).toBe("passed");
    expect(listEngineeringGraphStates(root).map((item) => item.graphId)).toEqual(["routed"]);
  });

  it("pauses at a gate and resumes without rerunning ancestors", async () => {
    const root = workspace();
    const before = vi.fn(() => ({ output: "ready" }));
    const after = vi.fn(() => ({ output: "done" }));
    const definition = {
      graphId: "approval",
      nodes: [
        { id: "before", kind: "function", handler: "before" },
        { id: "review", kind: "gate", dependsOn: ["before"] },
        { id: "after", kind: "function", handler: "after", dependsOn: ["review"] },
      ],
    };
    const paused = await runEngineeringGraph(deps, definition, {
      workspace: root,
      handlers: { before, after },
    });
    expect(paused.status).toBe("paused");
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();

    const resumed = await runEngineeringGraph(deps, definition, {
      workspace: root,
      resume: true,
      approvedNodeIds: ["review"],
      handlers: { before, after },
    });
    expect(resumed.status).toBe("passed");
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("requires exact callback approval and reruns a cancelled in-flight node on resume", async () => {
    const root = workspace();
    const gate = await runEngineeringGraph(
      deps,
      { graphId: "exact-approval", nodes: [{ id: "review", kind: "gate" }] },
      {
        workspace: root,
        approveNode: (() => "yes") as never,
      },
    );
    expect(gate.status).toBe("paused");

    const controller = new AbortController();
    const cancelledHandler = vi.fn(({ signal }: { signal: AbortSignal }) => {
      if (signal.aborted) throw new Error("aborted by caller");
      return { output: "unexpected" };
    });
    const definition = { graphId: "cancel-resume", nodes: [{ id: "run", kind: "function", handler: "run" }] };
    const cancelled = await runEngineeringGraph(deps, definition, {
      workspace: root,
      signal: controller.signal,
      handlers: { run: cancelledHandler },
      onEvent: (event) => {
        if (event.type === "node.started") controller.abort();
      },
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.results[0]?.error).toBe("Graph cancelled");

    const resumedHandler = vi.fn(() => ({ output: "done" }));
    const resumed = await runEngineeringGraph(deps, definition, {
      workspace: root,
      resume: true,
      handlers: { run: resumedHandler },
    });
    expect(resumed.status).toBe("passed");
    expect(resumedHandler).toHaveBeenCalledTimes(1);
  });

  it("reruns the selected node and all descendants", async () => {
    const root = workspace();
    const calls = { a: 0, b: 0, c: 0 };
    const definition = {
      graphId: "rerun",
      nodes: [
        { id: "a", kind: "function", handler: "a" },
        { id: "b", kind: "function", handler: "b", dependsOn: ["a"] },
        { id: "c", kind: "function", handler: "c", dependsOn: ["b"] },
      ],
    };
    const handlers = {
      a: () => ({ output: ++calls.a }),
      b: () => ({ output: ++calls.b }),
      c: () => ({ output: ++calls.c }),
    };
    await runEngineeringGraph(deps, definition, { workspace: root, handlers });
    await runEngineeringGraph(deps, definition, { workspace: root, handlers, resume: true, rerunFrom: ["b"] });
    expect(calls).toEqual({ a: 1, b: 2, c: 2 });
  });

  it("validates reruns before handlers and treats exhausted shared budgets as failure", async () => {
    const root = workspace();
    const handler = vi.fn(() => ({ costUsd: 1 }));
    const definition = {
      graphId: "budget",
      costBudgetUsd: 1,
      nodes: [
        { id: "first", kind: "function", handler: "run" },
        { id: "second", kind: "function", handler: "run", dependsOn: ["first"] },
      ],
    };
    await expect(
      runEngineeringGraph(deps, definition, { workspace: root, handlers: { run: handler }, rerunFrom: ["first"] }),
    ).rejects.toThrow(/requires resume/);
    expect(handler).not.toHaveBeenCalled();
    const state = await runEngineeringGraph(deps, definition, { workspace: root, handlers: { run: handler } });
    expect(state.status).toBe("failed");
    expect(state.results[1]).toMatchObject({ id: "second", status: "skipped", error: "Graph budget exhausted" });
  });

  it("rejects nested gates and settles timed-out attempts before retry", async () => {
    const root = workspace();
    const nested = {
      graphId: "nested-graph",
      nodes: [{ id: "approval", kind: "gate" }],
    };
    await expect(
      runEngineeringGraph(
        deps,
        { graphId: "parent", nodes: [{ id: "child", kind: "subgraph", graph: nested }] },
        { workspace: root },
      ),
    ).rejects.toThrow(/Nested Graph approval gates/);

    let active = 0;
    let maxActive = 0;
    const timed = await runEngineeringGraph(
      deps,
      {
        graphId: "timeout",
        nodes: [{ id: "slow", kind: "function", handler: "slow", timeoutMs: 5, maxRetries: 1 }],
      },
      {
        workspace: root,
        handlers: {
          slow: ({ signal }) =>
            new Promise((_, reject) => {
              active++;
              maxActive = Math.max(maxActive, active);
              signal.addEventListener(
                "abort",
                () =>
                  setTimeout(() => {
                    active--;
                    reject(new Error("settled"));
                  }, 5),
                { once: true },
              );
            }),
        },
      },
    );
    expect(timed.status).toBe("failed");
    expect(maxActive).toBe(1);
  });

  it("settles independent in-flight work before pausing at a gate", async () => {
    const root = workspace();
    mkdirSync(join(root, "trigger"));
    mkdirSync(join(root, "slow"));
    let slowSettled = false;
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "safe-pause",
        maxConcurrency: 2,
        nodes: [
          { id: "trigger", kind: "function", handler: "trigger", workspace: "trigger" },
          { id: "slow", kind: "function", handler: "slow", workspace: "slow" },
          { id: "approval", kind: "gate", dependsOn: ["trigger"] },
        ],
      },
      {
        workspace: root,
        handlers: {
          trigger: () => ({ output: "ready" }),
          slow: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                slowSettled = true;
                resolve({ output: "done" });
              }, 20),
            ),
        },
      },
    );
    expect(state.status).toBe("paused");
    expect(slowSettled).toBe(true);
    expect(state.results.find((result) => result.id === "slow")?.status).toBe("passed");
  });

  it("aborts and drains in-flight nodes when the scheduler exits exceptionally", async () => {
    const root = workspace();
    mkdirSync(join(root, "trigger"));
    mkdirSync(join(root, "slow"));
    let active = 0;
    const run = runEngineeringGraph(
      deps,
      {
        graphId: "exception-drain",
        maxConcurrency: 2,
        nodes: [
          { id: "trigger", kind: "function", handler: "trigger", workspace: "trigger" },
          { id: "slow", kind: "function", handler: "slow", workspace: "slow" },
          { id: "approval", kind: "gate", dependsOn: ["trigger"] },
        ],
      },
      {
        workspace: root,
        approveNode: () => {
          throw new Error("approval backend failed");
        },
        handlers: {
          trigger: () => ({ output: "ready" }),
          slow: ({ signal }) =>
            new Promise((_, reject) => {
              active++;
              signal.addEventListener(
                "abort",
                () => {
                  active--;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            }),
        },
      },
    );
    await expect(run).rejects.toThrow(/approval backend failed/);
    expect(active).toBe(0);
    expect(loadEngineeringGraphState(root, "exception-drain")?.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "slow", error: "Graph cancelled" })]),
    );
  });

  it("validates all handlers before effects and requires explicit restart for replacement", async () => {
    const root = workspace();
    const sideEffect = vi.fn(() => ({ output: "ran" }));
    await expect(
      runEngineeringGraph(
        deps,
        {
          graphId: "handlers",
          nodes: [
            { id: "first", kind: "function", handler: "first" },
            { id: "missing", kind: "function", handler: "missing", dependsOn: ["first"] },
          ],
        },
        { workspace: root, handlers: { first: sideEffect } },
      ),
    ).rejects.toThrow(/not registered/);
    expect(sideEffect).not.toHaveBeenCalled();
    const definition = { graphId: "replace", nodes: [{ id: "run", kind: "function", handler: "first" }] };
    await runEngineeringGraph(deps, definition, { workspace: root, handlers: { first: sideEffect } });
    await expect(
      runEngineeringGraph(deps, definition, { workspace: root, handlers: { first: sideEffect } }),
    ).rejects.toThrow(/already exists/);
    const restarted = await runEngineeringGraph(deps, definition, {
      workspace: root,
      restart: true,
      handlers: { first: sideEffect },
    });
    expect(restarted.status).toBe("passed");
  });

  it("shares remaining budgets across work that can actually launch", async () => {
    const root = workspace();
    mkdirSync(join(root, "first"));
    mkdirSync(join(root, "second"));
    const shares: Array<number | undefined> = [];
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "shares",
        maxConcurrency: 2,
        costBudgetUsd: 10,
        nodes: [
          { id: "first", kind: "function", handler: "run", workspace: "first" },
          { id: "second", kind: "function", handler: "run", workspace: "second", dependsOn: ["first"] },
        ],
      },
      {
        workspace: root,
        handlers: {
          run: ({ costBudgetUsd }) => {
            shares.push(costBudgetUsd);
            return { costUsd: 2 };
          },
        },
      },
    );
    expect(state.status).toBe("passed");
    expect(shares).toEqual([10, 8]);
  });

  it("rejects overlapping concurrent workspaces and serializes aggregate output accounting", async () => {
    const root = workspace();
    mkdirSync(join(root, "parent", "child"), { recursive: true });
    await expect(
      runEngineeringGraph(
        deps,
        {
          graphId: "overlap",
          maxConcurrency: 2,
          nodes: [
            { id: "parent", kind: "function", handler: "run", workspace: "parent" },
            { id: "child", kind: "function", handler: "run", workspace: "parent/child" },
          ],
        },
        { workspace: root, handlers: { run: () => ({}) } },
      ),
    ).rejects.toThrow(/non-overlapping/);

    const nodes = Array.from({ length: 15 }, (_, index) => {
      const id = `node-${index}`;
      mkdirSync(join(root, id));
      return {
        id,
        kind: "function" as const,
        handler: "run",
        workspace: id,
        ...(index >= 7 ? { dependsOn: ["node-6"] } : index > 0 ? { dependsOn: [`node-${index - 1}`] } : {}),
      };
    });
    const state = await runEngineeringGraph(
      deps,
      { graphId: "aggregate-output", maxConcurrency: 8, nodes },
      { workspace: root, handlers: { run: () => ({ output: "x".repeat(15_000) }) } },
    );
    const retainedBytes = state.results.reduce(
      (total, result) => total + (result.output === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.output))),
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(128 * 1024);
    expect(state.results.some((result) => (result.output as { truncated?: boolean })?.truncated)).toBe(true);
  });

  it("isolates observer failures and enforces output bounds", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      deps,
      { graphId: "observer", nodes: [{ id: "run", kind: "function", handler: "run" }] },
      {
        workspace: root,
        handlers: { run: () => ({ output: "ok" }) },
        onEvent: () => {
          throw new Error("ui broke");
        },
      },
    );
    expect(state.status).toBe("passed");
    expect(state.events.some((event) => event.type === "graph.warning")).toBe(true);

    const oversizedHandler = vi.fn(() => ({ output: "x".repeat(70_000) }));
    const oversized = await runEngineeringGraph(
      deps,
      { graphId: "oversized", nodes: [{ id: "run", kind: "function", handler: "run", maxRetries: 1 }] },
      { workspace: root, handlers: { run: oversizedHandler } },
    );
    expect(oversized.status).toBe("passed");
    expect(oversized.results[0]?.output).toMatchObject({ truncated: true });
    expect(oversizedHandler).toHaveBeenCalledTimes(1);
  });
});

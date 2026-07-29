import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineeringSubgraphStateId } from "../../src/agent/graph-contract.js";
import { enqueueGraphControl } from "../../src/agent/graph-control-store.js";
import { runEngineeringGraph, type GraphFunctionHandler } from "../../src/agent/graph-engineering.js";
import { readEngineeringGraphHistory } from "../../src/agent/graph-history.js";
import { readEngineeringGraphRunSnapshots } from "../../src/agent/graph-run-history.js";
import { enqueueEngineeringGraphSignal } from "../../src/agent/graph-signal-store.js";
import {
  archiveEngineeringGraphResources,
  inspectEngineeringGraphResources,
  pruneEngineeringGraphResources,
  pruneEngineeringGraphStates,
} from "../../src/agent/graph-resources.js";
import {
  listEngineeringGraphStates,
  loadEngineeringGraphState,
  recoverableEngineeringGraphStates,
  removeEngineeringGraphState,
  saveEngineeringGraphState,
} from "../../src/agent/graph-state.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import { listGitWorktrees } from "../../src/worktree.js";

const deps = {} as AgentCoreDeps;

describe("runEngineeringGraph", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const result = mkdtempSync(join(tmpdir(), "seekforge-graph-"));
    workspaces.push(result);
    return result;
  };
  const gitWorkspace = (): string => {
    const root = workspace();
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "graph-test@seekforge.local"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Graph Test"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
    return root;
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

  it("allows dependency-ordered effectful nodes to reuse a workspace", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "ordered-workspace",
        maxConcurrency: 2,
        nodes: [
          { id: "first", kind: "function", handler: "noop" },
          { id: "second", kind: "function", handler: "noop", dependsOn: ["first"] },
        ],
      },
      { workspace: root, handlers: { noop: () => ({ output: null }) } },
    );
    expect(state.status).toBe("passed");
  });

  it("executes bounded map dataflow and quorum joins with stable handler keys", async () => {
    const root = workspace();
    const keys: string[] = [];
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "map-join",
        maxConcurrency: 2,
        nodes: [
          { id: "source", kind: "function", handler: "source", outputSchema: { type: "object", required: ["items"] } },
          {
            id: "map",
            kind: "map",
            handler: "double",
            dependsOn: ["source"],
            source: { nodeId: "source", pointer: "/items" },
            inputs: { original: { nodeId: "source" } },
            outputSchema: { type: "array" },
          },
          { id: "join", kind: "join", dependsOn: ["source", "map"], quorum: 2 },
        ],
      },
      {
        workspace: root,
        handlers: {
          source: ({ idempotencyKey }) => {
            keys.push(idempotencyKey);
            return { output: { items: [1, 2, 3] } };
          },
          double: ({ item, itemIndex, inputs, idempotencyKey }) => {
            keys.push(idempotencyKey);
            expect(inputs.original).toEqual({ items: [1, 2, 3] });
            return {
              output: Number(item) * 2 + (itemIndex === undefined ? 0 : 0),
              artifacts: [{ name: `item-${itemIndex}`, path: `items/item-${itemIndex}.json` }],
            };
          },
        },
      },
    );
    expect(state.status).toBe("passed");
    expect(state.results.find((result) => result.id === "map")?.output).toEqual([2, 4, 6]);
    expect(state.results.find((result) => result.id === "join")?.output).toEqual({
      quorum: 2,
      passed: ["source", "map"],
    });
    expect(new Set(keys).size).toBe(4);
    expect(state.results.find((result) => result.id === "map")?.artifacts).toHaveLength(3);
    expect(state.activeAttempts).toEqual([]);
  });

  it("waits for every started map item before publishing a failed batch", async () => {
    const root = workspace();
    let peerSettled = false;
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "map-settlement",
        failurePolicy: "continue",
        nodes: [
          { id: "source", kind: "function", handler: "source" },
          {
            id: "map",
            kind: "map",
            handler: "map",
            dependsOn: ["source"],
            source: { nodeId: "source" },
          },
        ],
      },
      {
        workspace: root,
        handlers: {
          source: () => ({ output: [0, 1] }),
          map: async ({ item }) => {
            if (item === 0) throw new Error("first item failed");
            await new Promise((resolve) => setTimeout(resolve, 20));
            peerSettled = true;
            return { output: item };
          },
        },
      },
    );
    expect(state.status).toBe("failed");
    expect(peerSettled).toBe(true);
    expect(state.activeAttempts).toEqual([]);
  });

  it("reuses an interrupted handler key but allocates a new key for explicit rerun", async () => {
    const root = workspace();
    const definition = {
      graphId: "idempotency-recovery",
      nodes: [{ id: "effect", kind: "function", handler: "effect" }],
    };
    const observed: string[] = [];
    await runEngineeringGraph(deps, definition, {
      workspace: root,
      handlers: {
        effect: ({ idempotencyKey }) => {
          observed.push(idempotencyKey);
          return { output: "done" };
        },
      },
    });
    const checkpoint = loadEngineeringGraphState(root, definition.graphId)!;
    saveEngineeringGraphState(root, {
      ...checkpoint,
      status: "running",
      completedAt: undefined,
      results: [],
      activeAttempts: [
        {
          nodeId: "effect",
          attempt: 1,
          idempotencyKey: "interrupted-stable-key",
          startedAt: new Date().toISOString(),
        },
      ],
    });
    await runEngineeringGraph(deps, definition, {
      workspace: root,
      resume: true,
      handlers: {
        effect: ({ idempotencyKey }) => {
          observed.push(idempotencyKey);
          return { output: "resumed" };
        },
      },
    });
    await runEngineeringGraph(deps, definition, {
      workspace: root,
      resume: true,
      rerunFrom: ["effect"],
      handlers: {
        effect: ({ idempotencyKey }) => {
          observed.push(idempotencyKey);
          return { output: "rerun" };
        },
      },
    });
    expect(observed[1]).toBe("interrupted-stable-key");
    expect(observed[2]).not.toBe("interrupted-stable-key");
    expect(new Set(observed).size).toBe(3);
  });

  it("isolates managed nodes, integrates dependencies, verifies fan-in, and prunes archived resources", async () => {
    const root = gitWorkspace();
    const definition = {
      graphId: "managed-graph",
      managedWorktrees: true,
      fanIn: { verifyCommand: "test -f produced.txt", maxIterations: 1 },
      nodes: [
        { id: "producer", kind: "function", handler: "producer" },
        { id: "review", kind: "gate", dependsOn: ["producer"] },
        { id: "consumer", kind: "function", handler: "consumer", dependsOn: ["review"] },
      ],
    };
    const handlers = {
      producer: ({ workspace: nodeWorkspace }: { workspace: string }) => {
        writeFileSync(join(nodeWorkspace, "produced.txt"), "ready\n");
        return { output: "produced" };
      },
      consumer: ({ workspace: nodeWorkspace }: { workspace: string }) => ({
        output: existsSync(join(nodeWorkspace, "produced.txt")) ? "integrated" : "missing",
      }),
    };
    const fanInCheckpoint: { current: ReturnType<typeof loadEngineeringGraphState> } = { current: null };
    const state = await runEngineeringGraph(deps, definition, {
      workspace: root,
      handlers,
      approvedNodeIds: ["review"],
      onEvent: (event) => {
        if (event.type === "graph.completed") {
          fanInCheckpoint.current = loadEngineeringGraphState(root, "managed-graph");
        }
      },
    });

    expect(state.status).toBe("passed");
    expect(fanInCheckpoint.current?.status).toBe("running");
    expect(fanInCheckpoint.current?.completedAt).toBeUndefined();
    expect(state.results[2]?.output).toBe("integrated");
    expect(
      state.results
        .filter((result) => result.kind !== "gate" && result.kind !== "router")
        .every((result) => result.managedBranch?.startsWith("seekforge/")),
    ).toBe(true);
    expect(state.fanIn?.status).toBe("passed");
    expect(await listGitWorktrees(root)).toHaveLength(4);

    const report = await inspectEngineeringGraphResources(root, "managed-graph");
    expect(report.worktrees).toHaveLength(3);
    expect(report.archived).toBe(false);
    archiveEngineeringGraphResources(root, "managed-graph");
    const pruned = await pruneEngineeringGraphResources(root, "managed-graph");
    expect(pruned.removed).toHaveLength(3);
    expect(await listGitWorktrees(root)).toHaveLength(1);

    const restarted = await runEngineeringGraph(deps, definition, {
      workspace: root,
      restart: true,
      handlers,
      approvedNodeIds: ["review"],
    });
    expect(restarted.status).toBe("passed");
    expect(readEngineeringGraphRunSnapshots(root, "managed-graph")).toEqual([
      expect.objectContaining({ runNumber: 1, status: "passed" }),
    ]);
    expect((await inspectEngineeringGraphResources(root, "managed-graph")).archived).toBe(false);
  }, 30_000);

  it("provisions and cleans nested managed Graph worktrees through the parent resource lifecycle", async () => {
    const root = gitWorkspace();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "nested-managed-parent",
        managedWorktrees: true,
        nodes: [
          {
            id: "child",
            kind: "subgraph",
            graph: {
              graphId: "nested-managed-child",
              managedWorktrees: true,
              nodes: [{ id: "write", kind: "function", handler: "write" }],
            },
          },
        ],
      },
      {
        workspace: root,
        handlers: {
          write: ({ workspace: childWorkspace }) => {
            writeFileSync(join(childWorkspace, "nested.txt"), "nested\n");
            return { output: "done", artifacts: [{ name: "nested", path: "nested.txt" }] };
          },
        },
      },
    );
    expect(state.status).toBe("passed");
    expect((await inspectEngineeringGraphResources(root, "nested-managed-parent")).worktrees).toHaveLength(2);
    archiveEngineeringGraphResources(root, "nested-managed-parent");
    const nested = (await listGitWorktrees(root))
      .filter((entry) => entry.branch.startsWith("seekforge/"))
      .sort((left, right) => right.path.length - left.path.length)[0];
    expect(nested).toBeDefined();
    const dirty = join(nested!.path, "dirty.txt");
    writeFileSync(dirty, "keep\n");
    const retained = await pruneEngineeringGraphResources(root, "nested-managed-parent");
    expect(retained.removed).toEqual([]);
    expect(retained.retained).toHaveLength(2);
    rmSync(dirty);
    expect((await pruneEngineeringGraphResources(root, "nested-managed-parent")).removed).toHaveLength(2);
    expect(await listGitWorktrees(root)).toHaveLength(1);
  }, 30_000);

  it("retains dirty managed Graph resources during pruning", async () => {
    const root = gitWorkspace();
    await runEngineeringGraph(
      deps,
      { graphId: "dirty-graph", managedWorktrees: true, nodes: [{ id: "node", kind: "function", handler: "node" }] },
      { workspace: root, handlers: { node: () => ({ output: "done" }) } },
    );
    const managed = (await listGitWorktrees(root)).find((entry) => entry.branch.includes("dirty-graph"));
    expect(managed).toBeDefined();
    writeFileSync(join(managed!.path, "uncommitted.txt"), "keep\n");
    archiveEngineeringGraphResources(root, "dirty-graph");
    const pruned = await pruneEngineeringGraphResources(root, "dirty-graph");
    expect(pruned.removed).toEqual([]);
    expect(pruned.retained).toEqual([managed!.branch]);
  }, 30_000);

  it("persists a recoverable cancellation while managed fan-in is starting", async () => {
    const root = gitWorkspace();
    const controller = new AbortController();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "cancel-fanin",
        managedWorktrees: true,
        fanIn: { verifyCommand: "true", maxIterations: 1 },
        nodes: [{ id: "node", kind: "function", handler: "node" }],
      },
      {
        workspace: root,
        signal: controller.signal,
        handlers: { node: () => ({ output: "done" }) },
        onEvent: (event) => {
          if (event.type === "fan_in.started") controller.abort();
        },
      },
    );
    expect(state.status).toBe("cancelled");
    expect(state.fanIn?.status).toBe("failed");
    expect(loadEngineeringGraphState(root, "cancel-fanin")?.status).toBe("cancelled");
  }, 30_000);

  it("does not let an invalid observational history target block checkpoints", async () => {
    const root = workspace();
    const graphDirectory = join(root, ".seekforge", "graphs");
    mkdirSync(graphDirectory, { recursive: true });
    const unrelated = join(root, "unrelated.log");
    writeFileSync(unrelated, "keep");
    symlinkSync(unrelated, join(graphDirectory, "history-symlink.jsonl"));
    const state = await runEngineeringGraph(
      deps,
      { graphId: "history-symlink", nodes: [{ id: "done", kind: "function", handler: "noop" }] },
      { workspace: root, handlers: { noop: () => ({ output: null }) } },
    );
    expect(state.status).toBe("passed");
    expect(loadEngineeringGraphState(root, "history-symlink")?.status).toBe("passed");
  });

  it("isolates a malformed control mailbox from authoritative Graph execution", async () => {
    const root = workspace();
    const graphDirectory = join(root, ".seekforge", "graphs");
    mkdirSync(graphDirectory, { recursive: true });
    writeFileSync(join(graphDirectory, "control-corruption.control.json"), "{");
    const state = await runEngineeringGraph(
      deps,
      { graphId: "control-corruption", nodes: [{ id: "done", kind: "function", handler: "noop" }] },
      { workspace: root, handlers: { noop: () => ({ output: null }) } },
    );
    expect(state.status).toBe("passed");
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "graph.warning", message: expect.stringMatching(/mailbox/) }),
      ]),
    );
  });

  it("prunes eligible terminal Graph state without initializing Git resources", async () => {
    const root = workspace();
    await runEngineeringGraph(
      deps,
      { graphId: "old-graph", nodes: [{ id: "done", kind: "function", handler: "noop" }] },
      { workspace: root, handlers: { noop: () => ({ output: null }) } },
    );
    const result = await pruneEngineeringGraphStates(root, { maxAgeDays: 0, maxTerminalCount: 0 });
    expect(result.removed).toEqual(["old-graph"]);
    expect(loadEngineeringGraphState(root, "old-graph")).toBeNull();
  });

  it("retains terminal child checkpoints while their parent remains resumable", async () => {
    const root = workspace();
    const definition = {
      graphId: "retained-parent",
      nodes: [
        {
          id: "child",
          kind: "subgraph",
          graph: {
            graphId: "retained-child",
            nodes: [{ id: "done", kind: "function", handler: "done" }],
          },
        },
        { id: "review", kind: "gate", dependsOn: ["child"] },
      ],
    };
    const parent = await runEngineeringGraph(deps, definition, {
      workspace: root,
      handlers: { done: () => ({ output: "done" }) },
    });
    expect(parent.status).toBe("paused");
    const childId = engineeringSubgraphStateId("retained-parent", "child", "retained-child");
    expect(loadEngineeringGraphState(root, childId)?.status).toBe("passed");
    expect(await pruneEngineeringGraphStates(root, { maxAgeDays: 0, maxTerminalCount: 0 })).toEqual({
      removed: [],
      retained: [],
    });
    expect(loadEngineeringGraphState(root, childId)?.status).toBe("passed");
  });

  it("migrates version-1 checkpoints in memory before resume", () => {
    const root = workspace();
    const directory = join(root, ".seekforge", "graphs");
    mkdirSync(directory, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(directory, "legacy.json"),
      JSON.stringify({
        schemaVersion: 1,
        graphId: "legacy",
        fingerprint: "a".repeat(64),
        status: "passed",
        definition: {
          graphId: "legacy",
          nodes: [{ id: "done", kind: "function", handler: "noop" }],
          maxConcurrency: 1,
          failurePolicy: "stop",
        },
        results: [
          {
            id: "done",
            kind: "function",
            status: "passed",
            attempts: 1,
            costUsd: 0,
            tokensUsed: 0,
            startedAt: now,
            completedAt: now,
          },
        ],
        events: [],
        spentCost: 0,
        spentTokens: 0,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      }),
    );
    expect(loadEngineeringGraphState(root, "legacy")).toMatchObject({
      schemaVersion: 2,
      activeAttempts: [],
      controlSeq: 0,
      controlRunId: "",
    });
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

  it("applies durable pause at a safe boundary and resumes without replaying settled nodes", async () => {
    const root = workspace();
    const first = vi.fn(() => ({ output: "first" }));
    const second = vi.fn(() => ({ output: "second" }));
    const definition = {
      graphId: "controlled",
      nodes: [
        { id: "first", kind: "function", handler: "first" },
        { id: "second", kind: "function", handler: "second", dependsOn: ["first"] },
      ],
    };
    let queued: Promise<unknown> | undefined;
    const paused = await runEngineeringGraph(deps, definition, {
      workspace: root,
      handlers: { first, second },
      onEvent: (event) => {
        if (event.type === "node.attempt.started") {
          const state = loadEngineeringGraphState(root, "controlled")!;
          queued = enqueueGraphControl(root, "controlled", state.controlRunId, { operation: "pause" });
        }
      },
    });
    await queued;
    expect(paused).toMatchObject({ status: "paused", pauseReason: "control" });
    const resumed = await runEngineeringGraph(deps, definition, {
      workspace: root,
      resume: true,
      handlers: { first, second },
    });
    expect(resumed.status).toBe("passed");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
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

  it("keeps cancellation checkpoints recoverable while pending nodes are materialized", async () => {
    const root = workspace();
    const controller = new AbortController();
    const intermediate: { current: ReturnType<typeof loadEngineeringGraphState> } = { current: null };
    let skipped = 0;
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "cancel-checkpoint",
        nodes: [
          { id: "first", kind: "function", handler: "noop" },
          { id: "second", kind: "function", handler: "noop" },
        ],
      },
      {
        workspace: root,
        handlers: { noop: () => ({ output: null }) },
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "graph.started") controller.abort();
          if (event.type === "node.skipped" && ++skipped === 2) {
            intermediate.current = loadEngineeringGraphState(root, "cancel-checkpoint");
          }
        },
      },
    );
    expect(intermediate.current).toMatchObject({ status: "running", results: [{ id: "first" }] });
    expect(state.status).toBe("cancelled");
  });

  it("normalizes a subgraph that pauses while cancellation is draining", async () => {
    const root = workspace();
    mkdirSync(join(root, "child"));
    mkdirSync(join(root, "sibling"));
    const controller = new AbortController();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "cancel-pausing-child",
        maxConcurrency: 2,
        nodes: [
          {
            id: "child",
            kind: "subgraph",
            workspace: "child",
            graph: { graphId: "approval-child", nodes: [{ id: "review", kind: "gate" }] },
          },
          { id: "sibling", kind: "function", handler: "cancel", workspace: "sibling" },
        ],
      },
      {
        workspace: root,
        signal: controller.signal,
        handlers: {
          cancel: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                controller.abort();
                resolve({ output: "cancelled" });
              }, 10);
            }),
        },
      },
    );
    expect(state.status).toBe("cancelled");
    expect(state.results.some((result) => result.status === "waiting_approval")).toBe(false);
    expect(loadEngineeringGraphState(root, "cancel-pausing-child")?.status).toBe("cancelled");
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

  it("persists nested gates and resumes them with a scoped approval", async () => {
    const root = workspace();
    const before = vi.fn(() => ({ output: "ready", costUsd: 1 }));
    const after = vi.fn(() => ({ output: "done", costUsd: 1 }));
    const nested = {
      graphId: "nested-graph",
      nodes: [
        { id: "before", kind: "function", handler: "before" },
        { id: "approval", kind: "gate", dependsOn: ["before"] },
        { id: "after", kind: "function", handler: "after", dependsOn: ["approval"] },
      ],
    };
    const parent = {
      graphId: "parent",
      costBudgetUsd: 3,
      nodes: [{ id: "child", kind: "subgraph", graph: nested }],
    };
    const waitingCheckpoint: { current: ReturnType<typeof loadEngineeringGraphState> } = { current: null };
    const paused = await runEngineeringGraph(deps, parent, {
      workspace: root,
      handlers: { before, after },
      onEvent: (event) => {
        if (event.type === "graph.paused") waitingCheckpoint.current = loadEngineeringGraphState(root, "parent");
      },
    });
    expect(paused.status).toBe("paused");
    expect(waitingCheckpoint.current).toMatchObject({ status: "paused", results: [{ status: "waiting_approval" }] });
    expect(paused.spentCost).toBe(1);
    expect(paused.results[0]).toMatchObject({
      id: "child",
      status: "waiting_approval",
      output: { waitingFor: ["child/approval"] },
    });
    const childGraphId = engineeringSubgraphStateId("parent", "child", "nested-graph");
    expect(loadEngineeringGraphState(root, childGraphId)).toMatchObject({
      status: "paused",
      parentGraph: { graphId: "parent", nodeId: "child" },
    });
    const resumed = await runEngineeringGraph(deps, parent, {
      workspace: root,
      handlers: { before, after },
      resume: true,
      approvedNodeIds: ["child/approval"],
    });
    expect(resumed.status).toBe("passed");
    expect(resumed.spentCost).toBe(2);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("retries and selectively reruns a durable subgraph without replaying passed siblings", async () => {
    const root = workspace();
    const first = vi.fn(() => ({ output: "first" }));
    let failures = 0;
    const second = vi.fn(() => {
      if (failures++ === 0) throw new Error("retry child");
      return { output: "second" };
    });
    const parent = {
      graphId: "retry-parent",
      nodes: [
        {
          id: "child",
          kind: "subgraph",
          maxRetries: 1,
          graph: {
            graphId: "retry-child",
            nodes: [
              { id: "first", kind: "function", handler: "first" },
              { id: "second", kind: "function", handler: "second", dependsOn: ["first"] },
            ],
          },
        },
      ],
    };
    const passed = await runEngineeringGraph(deps, parent, { workspace: root, handlers: { first, second } });
    expect(passed.status).toBe("passed");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    const rerun = await runEngineeringGraph(deps, parent, {
      workspace: root,
      handlers: { first, second },
      resume: true,
      rerunFrom: ["child/second"],
    });
    expect(rerun.status).toBe("passed");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("recovers a settled child checkpoint when the parent missed settlement", async () => {
    const root = workspace();
    const handler = vi.fn(() => ({ output: "durable", costUsd: 0.5 }));
    const parent = {
      graphId: "crash-parent",
      costBudgetUsd: 2,
      nodes: [
        {
          id: "child",
          kind: "subgraph",
          graph: {
            graphId: "crash-child",
            nodes: [{ id: "effect", kind: "function", handler: "effect" }],
          },
        },
      ],
    };
    const completed = await runEngineeringGraph(deps, parent, { workspace: root, handlers: { effect: handler } });
    const interrupted = {
      ...completed,
      status: "running",
      results: [],
      spentCost: 0,
      spentTokens: 0,
    } as typeof completed;
    delete interrupted.completedAt;
    saveEngineeringGraphState(root, interrupted);
    const recovered = await runEngineeringGraph(deps, parent, {
      workspace: root,
      handlers: { effect: handler },
      resume: true,
    });
    expect(recovered.status).toBe("passed");
    expect(recovered.spentCost).toBe(0.5);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched child checkpoint before resumed sibling effects", async () => {
    const root = workspace();
    const childEffect = vi.fn(() => ({ output: "child" }));
    const siblingEffect = vi.fn(() => ({ output: "sibling" }));
    const parent = {
      graphId: "preflight-parent",
      maxConcurrency: 2,
      nodes: [
        {
          id: "child",
          kind: "subgraph",
          workspace: "child",
          graph: {
            graphId: "preflight-child",
            nodes: [{ id: "effect", kind: "function", handler: "child-effect" }],
          },
        },
        { id: "sibling", kind: "function", handler: "sibling-effect", workspace: "sibling" },
      ],
    };
    mkdirSync(join(root, "child"));
    mkdirSync(join(root, "sibling"));
    const completed = await runEngineeringGraph(deps, parent, {
      workspace: root,
      handlers: { "child-effect": childEffect, "sibling-effect": siblingEffect },
    });
    const childGraphId = engineeringSubgraphStateId("preflight-parent", "child", "preflight-child");
    const child = loadEngineeringGraphState(join(root, "child"), childGraphId)!;
    saveEngineeringGraphState(join(root, "child"), { ...child, fingerprint: "b".repeat(64) });
    const interrupted = {
      ...completed,
      status: "running",
      results: [],
      spentCost: 0,
      spentTokens: 0,
    } as typeof completed;
    delete interrupted.completedAt;
    saveEngineeringGraphState(root, interrupted);
    childEffect.mockClear();
    siblingEffect.mockClear();

    await expect(
      runEngineeringGraph(deps, parent, {
        workspace: root,
        resume: true,
        handlers: { "child-effect": childEffect, "sibling-effect": siblingEffect },
      }),
    ).rejects.toThrow(/does not match/);
    expect(childEffect).not.toHaveBeenCalled();
    expect(siblingEffect).not.toHaveBeenCalled();

    rmSync(join(root, "child", ".seekforge", "graphs", `${childGraphId}.json`));
    await expect(
      runEngineeringGraph(deps, parent, {
        workspace: root,
        resume: true,
        handlers: { "child-effect": childEffect, "sibling-effect": siblingEffect },
      }),
    ).rejects.toThrow(/subgraph not found or invalid/);
    expect(childEffect).not.toHaveBeenCalled();
    expect(siblingEffect).not.toHaveBeenCalled();
  });

  it("does not adopt an orphaned child checkpoint on a fresh parent retry", async () => {
    const root = workspace();
    const handler = vi.fn(() => ({ output: "effect" }));
    const parent = {
      graphId: "orphan-parent",
      nodes: [
        {
          id: "child",
          kind: "subgraph",
          maxRetries: 2,
          graph: { graphId: "orphan-child", nodes: [{ id: "effect", kind: "function", handler: "effect" }] },
        },
      ],
    };
    expect((await runEngineeringGraph(deps, parent, { workspace: root, handlers: { effect: handler } })).status).toBe(
      "passed",
    );
    expect(removeEngineeringGraphState(root, "orphan-parent")).toBe(true);
    const collision = await runEngineeringGraph(deps, parent, { workspace: root, handlers: { effect: handler } });
    expect(collision.status).toBe("failed");
    expect(collision.results[0]?.attempts).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const restarted = await runEngineeringGraph(deps, parent, {
      workspace: root,
      handlers: { effect: handler },
      restart: true,
    });
    expect(restarted.status).toBe("passed");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("settles timed-out attempts before retry", async () => {
    const root = workspace();

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
    saveEngineeringGraphState(root, {
      ...state,
      results: state.results.map((result) => ({ ...result, output: "x".repeat(15_000) })),
    });
    expect(loadEngineeringGraphState(root, "aggregate-output")).toBeNull();
  }, 10_000);

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
    expect(readEngineeringGraphHistory(root, "observer").some((entry) => entry.event.type === "graph.warning")).toBe(
      true,
    );

    const oversizedHandler = vi.fn(() => ({ output: "x".repeat(70_000) }));
    const oversized = await runEngineeringGraph(
      deps,
      { graphId: "oversized", nodes: [{ id: "run", kind: "function", handler: "run", maxRetries: 1 }] },
      { workspace: root, handlers: { run: oversizedHandler } },
    );
    expect(oversized.status).toBe("passed");
    expect(oversized.results[0]?.output).toMatchObject({ truncated: true });
    expect(oversizedHandler).toHaveBeenCalledTimes(1);
    saveEngineeringGraphState(root, {
      ...oversized,
      results: oversized.results.map((result) => ({ ...result, output: "x".repeat(17_000) })),
    });
    expect(loadEngineeringGraphState(root, "oversized")).toBeNull();
  });

  it("checkpoints successful map items and retries only unfinished items", async () => {
    const root = workspace();
    const calls = [0, 0];
    let fail = true;
    const definition = {
      graphId: "map-checkpoints",
      nodes: [
        { id: "source", kind: "function", handler: "source" },
        {
          id: "map",
          kind: "map",
          handler: "map",
          dependsOn: ["source"],
          source: { nodeId: "source" },
          maxRetries: 0,
        },
      ],
    };
    const handlers = {
      source: () => ({ output: [1, 2] }),
      map: ({ itemIndex }) => {
        calls[itemIndex!] = calls[itemIndex!]! + 1;
        if (itemIndex === 1 && fail) throw new Error("retry me");
        return { output: itemIndex };
      },
    } satisfies Record<string, GraphFunctionHandler>;
    const failed = await runEngineeringGraph(deps, definition, { workspace: root, handlers });
    expect(failed.status).toBe("failed");
    expect(failed.mapProgress?.map).toHaveLength(1);
    fail = false;
    const resumed = await runEngineeringGraph(deps, definition, {
      workspace: root,
      handlers,
      resume: true,
      rerunFrom: ["map"],
    });
    expect(resumed.status).toBe("passed");
    expect(resumed.results.find((result) => result.id === "map")?.output).toEqual([0, 1]);
    expect(calls).toEqual([1, 2]);
    expect(resumed.mapProgress?.map).toBeUndefined();
  });

  it("settles map result validation before publishing a sibling failure", async () => {
    const root = workspace();
    const calls = [0, 0];
    let invalidArtifact = true;
    const definition = {
      graphId: "map-postprocess-checkpoints",
      nodes: [
        { id: "source", kind: "function", handler: "source" },
        { id: "map", kind: "map", handler: "map", dependsOn: ["source"], source: { nodeId: "source" } },
      ],
    };
    const handlers = {
      source: () => ({ output: [1, 2] }),
      map: ({ itemIndex }) => {
        calls[itemIndex!] = calls[itemIndex!]! + 1;
        return itemIndex === 0 && invalidArtifact
          ? { costUsd: 1, artifacts: [{ name: "1-invalid", path: "artifact.txt" }] }
          : { costUsd: 1, output: itemIndex };
      },
    } satisfies Record<string, GraphFunctionHandler>;
    const failed = await runEngineeringGraph(deps, definition, { workspace: root, handlers });
    expect(failed.status).toBe("failed");
    expect(failed.spentCost).toBe(2);
    expect(failed.mapProgress?.map?.map((item) => item.index)).toEqual([1]);

    invalidArtifact = false;
    const resumed = await runEngineeringGraph(deps, definition, {
      workspace: root,
      handlers,
      resume: true,
      rerunFrom: ["map"],
    });
    expect(resumed.status).toBe("passed");
    expect(resumed.results.find((result) => result.id === "map")?.output).toEqual([0, 1]);
    expect(calls).toEqual([2, 1]);
  });

  it("durably waits for an external signal and resumes with its payload", async () => {
    const root = workspace();
    const definition = {
      graphId: "signal-wait",
      nodes: [{ id: "approval-event", kind: "wait", waitFor: { signal: "approved" } }],
    };
    const paused = await runEngineeringGraph(deps, definition, { workspace: root });
    expect(paused).toMatchObject({ status: "paused", pauseReason: "wait" });
    await enqueueEngineeringGraphSignal(root, "signal-wait", "approved", { actor: "reviewer" });
    expect(recoverableEngineeringGraphStates(root).map((state) => state.graphId)).toContain("signal-wait");
    const resumed = await runEngineeringGraph(deps, definition, { workspace: root, resume: true });
    expect(resumed.status).toBe("passed");
    expect(resumed.results[0]?.output).toMatchObject({ signal: "approved", payload: { actor: "reviewer" } });
    expect(JSON.parse(readFileSync(join(root, ".seekforge/graphs/signal-wait.signals.json"), "utf8"))).toEqual({
      version: 1,
      signals: [],
    });
  });

  it("reconciles a signal claim left after its passed wait checkpoint", async () => {
    const root = workspace();
    const definition = {
      graphId: "signal-reconcile",
      nodes: [{ id: "external", kind: "wait", waitFor: { signal: "continue" } }],
    };
    await runEngineeringGraph(deps, definition, { workspace: root });
    await enqueueEngineeringGraphSignal(root, "signal-reconcile", "continue");
    const passed = await runEngineeringGraph(deps, definition, { workspace: root, resume: true });
    const signalId = (passed.results[0]?.output as { signalId?: string } | undefined)?.signalId;
    expect(signalId).toEqual(expect.any(String));
    writeFileSync(
      join(root, ".seekforge/graphs/signal-reconcile.signals.json"),
      `${JSON.stringify({
        version: 1,
        signals: [
          {
            id: signalId as string,
            name: "continue",
            createdAt: new Date().toISOString(),
            claimedBy: "external",
            claimedAt: new Date().toISOString(),
          },
        ],
      })}\n`,
    );

    await runEngineeringGraph(deps, definition, { workspace: root, resume: true });
    expect(JSON.parse(readFileSync(join(root, ".seekforge/graphs/signal-reconcile.signals.json"), "utf8"))).toEqual({
      version: 1,
      signals: [],
    });
  });

  it("keeps the total duration budget cumulative while excluding offline pause time", async () => {
    const root = workspace();
    let clock = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const definition = {
      graphId: "duration-resume",
      maxDurationMs: 60,
      nodes: [
        { id: "before", kind: "function", handler: "before" },
        { id: "approval", kind: "gate", dependsOn: ["before"] },
        { id: "after", kind: "function", handler: "after", dependsOn: ["approval"] },
      ],
    };
    try {
      const paused = await runEngineeringGraph(deps, definition, {
        workspace: root,
        handlers: {
          before: () => {
            clock += 40;
            return {};
          },
          after: () => {
            clock += 30;
            return {};
          },
        },
      });
      expect(paused).toMatchObject({ status: "paused", elapsedMs: 40 });
      clock += 1_000;
      const resumed = await runEngineeringGraph(deps, definition, {
        workspace: root,
        resume: true,
        approvedNodeIds: ["approval"],
        handlers: {
          before: () => ({}),
          after: () => {
            clock += 30;
            return {};
          },
        },
      });
      expect(resumed).toMatchObject({ status: "failed", elapsedMs: 70 });
    } finally {
      now.mockRestore();
    }
  });

  it("rejects signals created after a wait deadline", async () => {
    const root = workspace();
    await enqueueEngineeringGraphSignal(root, "expired-wait", "approved", { late: true });
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "expired-wait",
        nodes: [
          {
            id: "deadline",
            kind: "wait",
            waitFor: { signal: "approved", expiresAt: "2000-01-01T00:00:00.000Z" },
          },
        ],
      },
      { workspace: root },
    );
    expect(state.status).toBe("failed");
    expect(state.results[0]?.error).toBe("Graph wait expired");
  });

  it("settles concurrent work before publishing a wait pause", async () => {
    const root = workspace();
    mkdirSync(join(root, "source"));
    mkdirSync(join(root, "failure"));
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "wait-settlement",
        maxConcurrency: 2,
        nodes: [
          { id: "source", kind: "function", handler: "source", workspace: "source" },
          { id: "failure", kind: "function", handler: "failure", workspace: "failure" },
          { id: "external", kind: "wait", dependsOn: ["source"], waitFor: { signal: "continue" } },
        ],
      },
      {
        workspace: root,
        handlers: {
          source: () => ({}),
          failure: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("boom");
          },
        },
      },
    );
    expect(state.status).toBe("failed");
    expect(state.results.find((result) => result.id === "external")).toMatchObject({
      status: "skipped",
      error: "Graph stopped after a node failure",
    });
    expect(loadEngineeringGraphState(root, "wait-settlement")?.status).toBe("failed");
  });

  it("runs compensation in reverse completion order after main work fails", async () => {
    const root = workspace();
    const order: string[] = [];
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "compensate",
        failurePolicy: "continue",
        nodes: [
          { id: "first", kind: "function", handler: "first" },
          { id: "second", kind: "function", handler: "second", dependsOn: ["first"] },
          { id: "fail", kind: "function", handler: "fail", dependsOn: ["second"] },
          {
            id: "undo-first",
            kind: "compensation",
            handler: "undo-first",
            dependsOn: ["first"],
            compensates: ["first"],
          },
          {
            id: "undo-second",
            kind: "compensation",
            handler: "undo-second",
            dependsOn: ["second"],
            compensates: ["second"],
          },
        ],
      },
      {
        workspace: root,
        handlers: {
          first: () => {
            order.push("first");
            return {};
          },
          second: () => {
            order.push("second");
            return {};
          },
          fail: () => {
            throw new Error("boom");
          },
          "undo-first": () => {
            order.push("undo-first");
            return {};
          },
          "undo-second": () => {
            order.push("undo-second");
            return {};
          },
        },
      },
    );
    expect(state.status).toBe("failed");
    expect(order.slice(-2)).toEqual(["undo-second", "undo-first"]);
  });

  it("does not let compensation exceed the shared graph budget", async () => {
    const root = workspace();
    const compensate = vi.fn(() => ({ costUsd: 1 }));
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "compensation-budget",
        costBudgetUsd: 1,
        nodes: [
          { id: "forward", kind: "function", handler: "forward" },
          { id: "blocked", kind: "function", handler: "blocked", dependsOn: ["forward"] },
          {
            id: "undo",
            kind: "compensation",
            handler: "undo",
            dependsOn: ["forward"],
            compensates: ["forward"],
          },
        ],
      },
      {
        workspace: root,
        handlers: {
          forward: () => ({ costUsd: 1 }),
          blocked: () => {
            throw new Error("must not run after the budget is exhausted");
          },
          undo: compensate,
        },
      },
    );
    expect(state.status).toBe("failed");
    expect(state.spentCost).toBe(1);
    expect(state.results.find((result) => result.id === "undo")).toMatchObject({
      status: "failed",
      attempts: 0,
      error: "Graph node retry budget exhausted",
    });
    expect(compensate).not.toHaveBeenCalled();
  });

  it("validates map source item schemas before invoking handlers", async () => {
    const root = workspace();
    const map = vi.fn(() => ({ output: true }));
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "map-source-schema",
        nodes: [
          { id: "source", kind: "function", handler: "source" },
          {
            id: "map",
            kind: "map",
            handler: "map",
            dependsOn: ["source"],
            source: { nodeId: "source", schema: { type: "array", items: { type: "number" } } },
          },
        ],
      },
      { workspace: root, handlers: { source: () => ({ output: ["wrong"] }), map } },
    );
    expect(state.status).toBe("failed");
    expect(state.results.find((result) => result.id === "map")?.error).toMatch(/must be number/);
    expect(map).not.toHaveBeenCalled();
  });

  it("shares a map node budget across each concurrent batch", async () => {
    const root = workspace();
    const shares: Array<{ cost?: number; tokens?: number }> = [];
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "map-budget-shares",
        costBudgetUsd: 2,
        tokenBudget: 4,
        nodes: [
          { id: "source", kind: "function", handler: "source" },
          {
            id: "map",
            kind: "map",
            handler: "map",
            dependsOn: ["source"],
            source: { nodeId: "source" },
            mapConcurrency: 2,
          },
        ],
      },
      {
        workspace: root,
        handlers: {
          source: () => ({ output: [1, 2] }),
          map: ({ costBudgetUsd, tokenBudget }) => {
            shares.push({ cost: costBudgetUsd, tokens: tokenBudget });
            return { output: true };
          },
        },
      },
    );
    expect(state.status).toBe("passed");
    expect(shares).toEqual([
      { cost: 1, tokens: 2 },
      { cost: 1, tokens: 2 },
    ]);
  });

  it("enforces deep schemas, verified artifact lineage, and trusted remote executors", async () => {
    const root = workspace();
    writeFileSync(join(root, "report.json"), "{}\n");
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "typed-remote",
        nodes: [
          {
            id: "remote",
            kind: "remote",
            executor: "worker",
            verifyArtifacts: true,
            outputSchema: {
              type: "object",
              required: ["items"],
              additionalProperties: false,
              properties: { items: { type: "array", minItems: 1, items: { type: "number" } } },
            },
          },
        ],
      },
      {
        workspace: root,
        executors: {
          worker: {
            trusted: true,
            locality: "remote",
            execute: () => ({
              output: { items: [1] },
              artifacts: [{ name: "report", path: "report.json" }],
            }),
          },
        },
      },
    );
    expect(state.status).toBe("passed");
    expect(state.results[0]?.artifacts?.[0]).toMatchObject({
      producerNodeId: "remote",
      verified: true,
      sizeBytes: 3,
    });
    expect(state.results[0]?.artifacts?.[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

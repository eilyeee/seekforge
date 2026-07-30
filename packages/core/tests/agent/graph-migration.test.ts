import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineeringSubgraphStateId } from "../../src/agent/graph-contract.js";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import {
  applyEngineeringGraphMigration,
  planEngineeringGraphMigration,
  readEngineeringGraphMigrationJournal,
} from "../../src/agent/graph-migration.js";
import { readEngineeringGraphRunSnapshots } from "../../src/agent/graph-run-history.js";
import { readEngineeringGraphHistory } from "../../src/agent/graph-history.js";
import { loadEngineeringGraphState, saveEngineeringGraphState } from "../../src/agent/graph-state.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

const deps = {} as AgentCoreDeps;

describe("Engineering Graph migration", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const result = mkdtempSync(join(tmpdir(), "seekforge-graph-migration-"));
    workspaces.push(result);
    return result;
  };

  afterEach(() => {
    for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("preserves unaffected results, invalidates descendants, and archives a terminal run", async () => {
    const root = workspace();
    const before = await runEngineeringGraph(
      deps,
      {
        graphId: "migrate",
        nodes: [
          { id: "prepare", kind: "function", handler: "prepare" },
          { id: "build", kind: "function", handler: "build", dependsOn: ["prepare"] },
          { id: "docs", kind: "function", handler: "docs" },
        ],
      },
      {
        workspace: root,
        handlers: {
          prepare: () => ({ costUsd: 1, tokensUsed: 10 }),
          build: () => ({ costUsd: 2, tokensUsed: 20 }),
          docs: () => ({ costUsd: 3, tokensUsed: 30 }),
        },
      },
    );
    const after = {
      graphId: "migrate",
      nodes: [
        { id: "prepare", kind: "function" as const, handler: "prepare" },
        { id: "build", kind: "function" as const, handler: "build-v2", dependsOn: ["prepare"] },
        { id: "release", kind: "function" as const, handler: "release", dependsOn: ["build"] },
        { id: "docs", kind: "function" as const, handler: "docs" },
      ],
    };

    const result = applyEngineeringGraphMigration(root, after);

    expect(result.plan).toMatchObject({
      changed: ["build"],
      added: ["release"],
      preserved: ["docs", "prepare"],
      invalidated: ["build", "release"],
    });
    expect(result.state.status).toBe("paused");
    expect(result.state.pauseReason).toBe("control");
    expect(result.state.results.map((item) => item.id)).toEqual(["prepare", "docs"]);
    expect(result.state.spentCost).toBe(4);
    expect(result.state.spentTokens).toBe(40);
    expect(result.state.events.at(-1)?.type).toBe("graph.migrated");
    expect(loadEngineeringGraphState(root, "migrate")).toEqual(result.state);
    expect(readEngineeringGraphRunSnapshots(root, "migrate")).toHaveLength(1);
    expect(readEngineeringGraphMigrationJournal(root, "migrate")).toMatchObject({
      phase: "committed",
      sourceFingerprint: before.fingerprint,
      targetFingerprint: result.state.fingerprint,
    });
    expect(applyEngineeringGraphMigration(root, after).state).toEqual(result.state);
    expect(readEngineeringGraphRunSnapshots(root, "migrate")).toHaveLength(1);
  });

  it("recomputes the authoritative plan instead of trusting an earlier plan", async () => {
    const root = workspace();
    const initial = await runEngineeringGraph(
      deps,
      { graphId: "authoritative", nodes: [{ id: "one", kind: "function", handler: "one" }] },
      { workspace: root, handlers: { one: () => ({}) } },
    );
    const after = { graphId: "authoritative", nodes: [{ id: "one", kind: "function" as const, handler: "two" }] };
    expect(planEngineeringGraphMigration(initial.definition, after).changed).toEqual(["one"]);
    expect(applyEngineeringGraphMigration(root, after).plan.changed).toEqual(["one"]);
  });

  it("recovers deterministically from a crash after preparing the migration journal", async () => {
    const root = workspace();
    const before = await runEngineeringGraph(
      deps,
      { graphId: "recover-migration", nodes: [{ id: "one", kind: "function", handler: "one" }] },
      { workspace: root, handlers: { one: () => ({}) } },
    );
    const after = {
      graphId: "recover-migration",
      nodes: [{ id: "one", kind: "function" as const, handler: "two" }],
    };
    expect(() =>
      applyEngineeringGraphMigration(root, after, {
        faultInjector: (point) => {
          if (point === "after_journal_prepared") throw new Error("simulated crash");
        },
      }),
    ).toThrow(/simulated crash/);
    expect(loadEngineeringGraphState(root, "recover-migration")?.fingerprint).toBe(before.fingerprint);
    expect(readEngineeringGraphMigrationJournal(root, "recover-migration")?.phase).toBe("prepared");
    const recovered = applyEngineeringGraphMigration(root, after);
    expect(recovered.state.fingerprint).not.toBe(before.fingerprint);
    expect(readEngineeringGraphMigrationJournal(root, "recover-migration")?.phase).toBe("committed");
  });

  it("repairs history exactly once after the migrated checkpoint was committed", async () => {
    const root = workspace();
    await runEngineeringGraph(
      deps,
      { graphId: "recover-history", nodes: [{ id: "one", kind: "function", handler: "one" }] },
      { workspace: root, handlers: { one: () => ({}) } },
    );
    const after = {
      graphId: "recover-history",
      nodes: [{ id: "one", kind: "function" as const, handler: "two" }],
    };
    expect(() =>
      applyEngineeringGraphMigration(root, after, {
        faultInjector: (point) => {
          if (point === "after_checkpoint_committed") throw new Error("simulated checkpoint crash");
        },
      }),
    ).toThrow(/simulated checkpoint crash/);
    expect(readEngineeringGraphMigrationJournal(root, "recover-history")?.phase).toBe("prepared");
    expect(
      readEngineeringGraphHistory(root, "recover-history").filter(({ event }) => event.type === "graph.migrated"),
    ).toHaveLength(0);

    const recovered = applyEngineeringGraphMigration(root, after);
    expect(recovered.state.events.at(-1)?.type).toBe("graph.migrated");
    expect(readEngineeringGraphMigrationJournal(root, "recover-history")?.phase).toBe("committed");
    expect(
      readEngineeringGraphHistory(root, "recover-history").filter(({ event }) => event.type === "graph.migrated"),
    ).toHaveLength(1);
    applyEngineeringGraphMigration(root, after);
    expect(
      readEngineeringGraphHistory(root, "recover-history").filter(({ event }) => event.type === "graph.migrated"),
    ).toHaveLength(1);
  });

  it("finishes a committed replacement before starting the next migration", async () => {
    const root = workspace();
    await runEngineeringGraph(
      deps,
      { graphId: "serial-migration", nodes: [{ id: "one", kind: "function", handler: "one" }] },
      { workspace: root, handlers: { one: () => ({}) } },
    );
    const second = {
      graphId: "serial-migration",
      nodes: [{ id: "one", kind: "function" as const, handler: "two" }],
    };
    expect(() =>
      applyEngineeringGraphMigration(root, second, {
        faultInjector: (point) => {
          if (point === "after_checkpoint_committed") throw new Error("simulated serial crash");
        },
      }),
    ).toThrow(/simulated serial crash/);

    const third = applyEngineeringGraphMigration(root, {
      graphId: "serial-migration",
      nodes: [{ id: "one", kind: "function", handler: "three" }],
    });
    expect(readEngineeringGraphMigrationJournal(root, "serial-migration")).toMatchObject({
      phase: "committed",
      targetFingerprint: third.state.fingerprint,
      resourceGeneration: third.state.resourceGeneration,
    });
    expect(
      readEngineeringGraphHistory(root, "serial-migration").filter(({ event }) => event.type === "graph.migrated"),
    ).toHaveLength(2);
  });

  it("rejects a prepared journal from another resource generation", async () => {
    const root = workspace();
    await runEngineeringGraph(
      deps,
      { graphId: "generation-conflict", nodes: [{ id: "one", kind: "function", handler: "one" }] },
      { workspace: root, handlers: { one: () => ({}) } },
    );
    const after = {
      graphId: "generation-conflict",
      nodes: [{ id: "one", kind: "function" as const, handler: "two" }],
    };
    expect(() =>
      applyEngineeringGraphMigration(root, after, {
        faultInjector: (point) => {
          if (point === "after_checkpoint_committed") throw new Error("simulated generation crash");
        },
      }),
    ).toThrow(/simulated generation crash/);
    const current = loadEngineeringGraphState(root, "generation-conflict")!;
    saveEngineeringGraphState(root, {
      ...current,
      resourceGeneration: "00000000-0000-4000-8000-000000000000",
    });
    expect(() => applyEngineeringGraphMigration(root, after)).toThrow(/unresolved migration journal/);
  });

  it("rejects running and managed-worktree checkpoints", async () => {
    const root = workspace();
    const terminal = await runEngineeringGraph(
      deps,
      { graphId: "unsafe", nodes: [{ id: "one", kind: "function", handler: "one" }] },
      { workspace: root, handlers: { one: () => ({}) } },
    );
    const { completedAt: _completedAt, ...withoutCompletion } = terminal;
    saveEngineeringGraphState(root, { ...withoutCompletion, status: "running" });
    expect(() => applyEngineeringGraphMigration(root, terminal.definition)).toThrow(/paused or terminal/);

    saveEngineeringGraphState(root, {
      ...terminal,
      definition: { ...terminal.definition, managedWorktrees: { integrateDependencies: false, limit: 1 } },
    });
    expect(() => applyEngineeringGraphMigration(root, terminal.definition)).toThrow(/managed worktrees/);

    saveEngineeringGraphState(root, {
      ...terminal,
      parentGraph: { graphId: "parent", nodeId: "child" },
    });
    expect(() => applyEngineeringGraphMigration(root, terminal.definition)).toThrow(/through their parent/);
  });

  it("rejects invalidation of an existing durable subgraph", async () => {
    const root = workspace();
    await runEngineeringGraph(
      deps,
      {
        graphId: "parent-migration",
        nodes: [
          {
            id: "child",
            kind: "subgraph",
            graph: {
              graphId: "child-definition",
              nodes: [{ id: "work", kind: "function", handler: "one" }],
            },
          },
        ],
      },
      { workspace: root, handlers: { one: () => ({}), two: () => ({}) } },
    );
    expect(() =>
      applyEngineeringGraphMigration(root, {
        graphId: "parent-migration",
        nodes: [
          {
            id: "child",
            kind: "subgraph",
            graph: {
              graphId: "child-definition",
              nodes: [{ id: "work", kind: "function", handler: "two" }],
            },
          },
        ],
      }),
    ).toThrow(/subgraph checkpoint/);
  });

  it("rejects an added subgraph that would bind to an orphan child checkpoint", async () => {
    const root = workspace();
    await runEngineeringGraph(
      deps,
      { graphId: "add-parent", nodes: [{ id: "base", kind: "function", handler: "one" }] },
      { workspace: root, handlers: { one: () => ({}) } },
    );
    const childId = engineeringSubgraphStateId("add-parent", "child", "child-definition");
    const childWorkspace = join(root, "child-workspace");
    mkdirSync(childWorkspace);
    await runEngineeringGraph(
      deps,
      { graphId: childId, nodes: [{ id: "work", kind: "function", handler: "one" }] },
      { workspace: childWorkspace, handlers: { one: () => ({}) } },
    );
    expect(() =>
      applyEngineeringGraphMigration(root, {
        graphId: "add-parent",
        nodes: [
          { id: "base", kind: "function", handler: "one" },
          {
            id: "child",
            kind: "subgraph",
            workspace: "child-workspace",
            graph: {
              graphId: "child-definition",
              nodes: [{ id: "work", kind: "function", handler: "one" }],
            },
          },
        ],
      }),
    ).toThrow(/existing child checkpoint/);
  });

  it("rejects malformed definitions before creating workspace state", () => {
    const root = workspace();
    expect(() => applyEngineeringGraphMigration(root, { graphId: "bad", nodes: "nope" })).toThrow();
    expect(existsSync(join(root, ".seekforge"))).toBe(false);
  });
});

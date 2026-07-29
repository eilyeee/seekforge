import { describe, expect, it } from "vitest";
import { parseEngineeringGraphDefinition } from "../../src/agent/graph-contract.js";
import { planEngineeringGraph } from "../../src/agent/graph-plan.js";

describe("parseEngineeringGraphDefinition", () => {
  it("normalizes a valid routed graph", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "delivery",
      nodes: [
        { id: "build", kind: "function", handler: "build" },
        {
          id: "route",
          kind: "router",
          dependsOn: ["build"],
          routes: [{ id: "ship", when: { nodeId: "build", status: "passed" } }, { id: "hold" }],
        },
        {
          id: "publish",
          kind: "function",
          handler: "publish",
          dependsOn: ["route"],
          route: { routerId: "route", branch: "ship" },
        },
      ],
    });

    expect(graph.maxConcurrency).toBe(1);
    expect(graph.failurePolicy).toBe("stop");
    expect(graph.nodes[2]?.route).toEqual({ routerId: "route", branch: "ship" });
  });

  it("rejects cycles and non-dependency condition references", () => {
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "cycle",
        nodes: [
          { id: "a", kind: "function", handler: "noop", dependsOn: ["b"] },
          { id: "b", kind: "function", handler: "noop", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(/cycle/);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "bad-condition",
        nodes: [
          { id: "a", kind: "function", handler: "noop" },
          { id: "b", kind: "function", handler: "noop", condition: { nodeId: "a", status: "passed" } },
        ],
      }),
    ).toThrow(/condition must reference a dependency/);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "ambiguous-condition",
        nodes: [
          { id: "a", kind: "function", handler: "noop" },
          {
            id: "b",
            kind: "function",
            handler: "noop",
            dependsOn: ["a"],
            condition: { nodeId: "a", status: "passed", not: { nodeId: "a", status: "failed" } },
          },
        ],
      }),
    ).toThrow(/exactly one/);
  });

  it("caps total nested nodes", () => {
    const childNodes = Array.from({ length: 128 }, (_, index) => ({
      id: `child-${index}`,
      kind: "function",
      handler: "noop",
    }));
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "root",
        nodes: [{ id: "nested", kind: "subgraph", graph: { graphId: "child", nodes: childNodes } }],
      }),
    ).toThrow(/in total/);
  });

  it("validates typed bindings, bounded map fan-out, quorum joins, and nested managed worktrees", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "dataflow",
      nodes: [
        { id: "source", kind: "function", handler: "source", outputSchema: { type: "object", required: ["items"] } },
        {
          id: "map",
          kind: "map",
          handler: "map",
          dependsOn: ["source"],
          source: { nodeId: "source", pointer: "/items" },
          maxItems: 8,
        },
        { id: "join", kind: "join", dependsOn: ["source", "map"], quorum: 2 },
        {
          id: "nested",
          kind: "subgraph",
          dependsOn: ["join"],
          graph: {
            graphId: "child",
            managedWorktrees: true,
            nodes: [{ id: "child-run", kind: "function", handler: "child" }],
          },
        },
      ],
    });
    expect(graph.nodes[1]).toMatchObject({ kind: "map", maxItems: 8 });
    expect(graph.nodes[3]?.graph?.managedWorktrees).toMatchObject({ integrateDependencies: true });
    expect(planEngineeringGraph(graph)).toMatchObject({
      criticalPath: ["source", "map", "join", "nested"],
      maxParallelWidth: 1,
      maxAttempts: 4,
      maxDynamicItems: 8,
    });
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "bad-binding",
        nodes: [
          { id: "source", kind: "function", handler: "source" },
          { id: "consumer", kind: "function", handler: "consume", inputs: { value: { nodeId: "source" } } },
        ],
      }),
    ).toThrow(/must reference a dependency/);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "bad-pointer",
        nodes: [
          { id: "source", kind: "function", handler: "source" },
          {
            id: "map",
            kind: "map",
            handler: "map",
            dependsOn: ["source"],
            source: { nodeId: "source", pointer: "/items~2invalid" },
          },
        ],
      }),
    ).toThrow(/binding is invalid/);
  });

  it("separates compensation phases and ranks the remaining critical path", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "planned-compensation",
      maxConcurrency: 2,
      nodes: [
        { id: "short", kind: "function", handler: "noop" },
        { id: "long-a", kind: "function", handler: "noop" },
        { id: "long-b", kind: "function", handler: "noop", dependsOn: ["long-a"] },
        { id: "long-c", kind: "function", handler: "noop", dependsOn: ["long-b"] },
        {
          id: "undo-long",
          kind: "compensation",
          handler: "noop",
          dependsOn: ["long-c"],
          compensates: ["long-c"],
        },
      ],
    });
    expect(planEngineeringGraph(graph)).toMatchObject({
      waves: [["short", "long-a"], ["long-b"], ["long-c"]],
      criticalPath: ["long-a", "long-b", "long-c"],
      compensationOrder: ["undo-long"],
    });
  });

  it("requires map source schemas to describe arrays", () => {
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "bad-source-schema",
        nodes: [
          { id: "source", kind: "function", handler: "noop" },
          {
            id: "map",
            kind: "map",
            handler: "noop",
            dependsOn: ["source"],
            source: { nodeId: "source", schema: { type: "string" } },
          },
        ],
      }),
    ).toThrow(/source schema must be array/);
  });

  it("keeps numeric schema enums stable across JSON persistence", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "numeric-schema",
      nodes: [{ id: "run", kind: "function", handler: "noop", outputSchema: { type: "number", enum: [-0, 1] } }],
    });
    expect(graph.nodes[0]?.outputSchema?.enum).toEqual([0, 1]);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "non-finite-schema",
        nodes: [{ id: "run", kind: "function", handler: "noop", outputSchema: { type: "number", enum: [Infinity] } }],
      }),
    ).toThrow(/enum is invalid/);
  });

  it("validates and exposes a cumulative graph duration budget", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "duration-budget",
      maxDurationMs: 30_000,
      nodes: [{ id: "run", kind: "function", handler: "noop" }],
    });
    expect(planEngineeringGraph(graph).maxDurationMs).toBe(30_000);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "invalid-duration",
        maxDurationMs: 0,
        nodes: [{ id: "run", kind: "function", handler: "noop" }],
      }),
    ).toThrow(/maxDurationMs/);
  });

  it("rejects sparse arrays and timer-overflow timeouts", () => {
    const sparseNodes = new Array(1);
    expect(() => parseEngineeringGraphDefinition({ graphId: "sparse", nodes: sparseNodes })).toThrow(/nodes/);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "timeout",
        nodes: [{ id: "run", kind: "function", handler: "noop", timeoutMs: 2_147_483_648 }],
      }),
    ).toThrow(/timeoutMs/);
    const sparseDependencies = new Array(1);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "sparse-dependencies",
        nodes: [{ id: "run", kind: "function", handler: "noop", dependsOn: sparseDependencies }],
      }),
    ).toThrow(/dependsOn/);
  });
});

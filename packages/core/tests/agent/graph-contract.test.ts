import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  engineeringGraphNeedsAgentRuntime,
  graphDefinitionFingerprint,
  graphDefinitionFingerprintMatches,
  parseEngineeringGraphDefinition,
  parseGraphLoopOptions,
} from "../../src/agent/graph-contract.js";
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

  it("validates exact bounded retry policies", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "retry-policy",
      nodes: [
        {
          id: "run",
          kind: "function",
          handler: "noop",
          maxRetries: 2,
          retryPolicy: { initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, jitterRatio: 0.1 },
        },
      ],
    });
    expect(graph.nodes[0]?.retryPolicy).toEqual({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      multiplier: 2,
      jitterRatio: 0.1,
    });
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "bad-retry-policy",
        nodes: [
          {
            id: "run",
            kind: "function",
            handler: "noop",
            maxRetries: 1,
            retryPolicy: { initialDelayMs: 100, maxDelayMs: 50, multiplier: 2, jitterRatio: 0 },
          },
        ],
      }),
    ).toThrow(/retryPolicy/);
  });

  it("validates scheduling, dynamic map, and remote capability contracts", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "expanded-contract",
      priorityAgingMs: 5_000,
      nodes: [
        { id: "source", kind: "function", handler: "source" },
        {
          id: "repair",
          kind: "map",
          mapKind: "agent",
          task: "Repair this item",
          dependsOn: ["source"],
          source: { nodeId: "source" },
          mapConcurrency: 1,
          deadlineAt: "2030-01-01T00:00:00.000Z",
        },
        {
          id: "remote",
          kind: "remote",
          executor: "worker",
          executorProtocolVersion: 1,
          requiresCancellation: true,
          dependsOn: ["repair"],
        },
      ],
    });
    expect(graph.priorityAgingMs).toBe(5_000);
    expect(graph.nodes[1]).toMatchObject({ mapKind: "agent", mapConcurrency: 1 });
    expect(engineeringGraphNeedsAgentRuntime(graph)).toBe(true);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "unsafe-map",
        nodes: [
          { id: "source", kind: "function", handler: "source" },
          {
            id: "repair",
            kind: "map",
            mapKind: "loop",
            task: "Repair",
            verifyCommand: "true",
            source: { nodeId: "source" },
            dependsOn: ["source"],
            mapConcurrency: 2,
          },
        ],
      }),
    ).toThrow(/mapConcurrency 1/);
  });

  it("keeps the legacy handler map default implicit for durable fingerprints", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "legacy-map",
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
    });
    expect(graph.nodes[1]).not.toHaveProperty("mapKind");
    expect(engineeringGraphNeedsAgentRuntime(graph)).toBe(false);
    const explicitDefault = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === "map" ? { ...node, mapKind: "handler" as const } : node)),
    };
    expect(graphDefinitionFingerprint(graph, new Map())).toBe(graphDefinitionFingerprint(explicitDefault, new Map()));
    const releaseFingerprint = createHash("sha256")
      .update(JSON.stringify({ definition: explicitDefault, workspaces: [] }))
      .digest("hex");
    expect(graphDefinitionFingerprintMatches(releaseFingerprint, explicitDefault, graph, new Map())).toBe(true);
    const tampered = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === "source" ? { ...node, handler: "tampered" } : node)),
    };
    expect(
      graphDefinitionFingerprintMatches(graphDefinitionFingerprint(graph, new Map()), tampered, graph, new Map()),
    ).toBe(false);
  });

  it("parses the bounded Loop options a loop node may declare", () => {
    const graph = parseEngineeringGraphDefinition({
      graphId: "loop-options",
      nodes: [
        {
          id: "repair",
          kind: "loop",
          task: "fix it",
          verifyCommand: "pnpm test",
          verifierId: "custom",
          outputPaths: ["dist/report.json"],
          budgetWeight: 2.5,
          failurePolicy: "stop",
          loopOptions: {
            maxIterations: 12,
            stablePasses: 2,
            flakyRetries: 1,
            codeReview: true,
            requirementMode: "analyze",
            model: "deepseek-chat",
            modelByFailureCategory: { test: "deepseek-reasoner" },
            modelRoutesByFailureCategory: { compile: ["deepseek-chat", "deepseek-reasoner"] },
            modelEscalationThreshold: 2,
            verificationPlan: [
              { id: "unit", command: "pnpm test", paths: ["packages/core"], dependencyPaths: ["packages/core"] },
              { id: "lint", command: "pnpm lint", dependsOn: ["unit"], parallel: true, resources: ["cpu"] },
            ],
          },
        },
      ],
    });
    expect(graph.nodes[0]?.loopOptions?.maxIterations).toBe(12);
    expect(graph.nodes[0]?.loopOptions?.verificationPlan?.[1]).toEqual({
      id: "lint",
      command: "pnpm lint",
      dependsOn: ["unit"],
      parallel: true,
      resources: ["cpu"],
    });
    expect(graph.nodes[0]?.budgetWeight).toBe(2.5);
    expect(graph.nodes[0]?.failurePolicy).toBe("stop");
    expect(graph.nodes[0]?.outputPaths).toEqual(["dist/report.json"]);

    const loopNode = (extra: Record<string, unknown>): unknown => ({
      graphId: "loop-bounds",
      nodes: [{ id: "repair", kind: "loop", task: "fix it", verifyCommand: "pnpm test", ...extra }],
    });
    expect(() => parseEngineeringGraphDefinition(loopNode({ loopOptions: { workspace: "/tmp" } }))).toThrow(
      /unsupported option/,
    );
    expect(() => parseEngineeringGraphDefinition(loopNode({ loopOptions: { persist: false } }))).toThrow(
      /unsupported option/,
    );
    expect(() => parseEngineeringGraphDefinition(loopNode({ loopOptions: { maxIterations: 0 } }))).toThrow(
      /maxIterations/,
    );
    expect(() => parseEngineeringGraphDefinition(loopNode({ loopOptions: { stablePasses: 6 } }))).toThrow(
      /stablePasses/,
    );
    expect(() =>
      parseEngineeringGraphDefinition(
        loopNode({ loopOptions: { autoVerificationPlan: true, verificationPlan: [{ id: "a", command: "true" }] } }),
      ),
    ).toThrow(/autoVerificationPlan/);
    expect(() =>
      parseEngineeringGraphDefinition(
        loopNode({
          loopOptions: {
            verificationPlan: [
              { id: "a", command: "true", dependsOn: ["b"] },
              { id: "b", command: "true", dependsOn: ["a"] },
            ],
          },
        }),
      ),
    ).toThrow(/cycle/);
    expect(() =>
      parseEngineeringGraphDefinition(
        loopNode({ loopOptions: { verificationPlan: [{ id: "a", command: "true", parallel: true }] } }),
      ),
    ).toThrow(/parallel requires resources/);
    expect(() =>
      parseEngineeringGraphDefinition(
        loopNode({
          loopOptions: { verificationPlan: [{ id: "a", command: "true", dependencyPaths: ["packages/core"] }] },
        }),
      ),
    ).toThrow(/subset of paths/);
    expect(() =>
      parseEngineeringGraphDefinition(
        loopNode({ loopOptions: { verificationPlan: [{ id: "a", command: "true", unknown: 1 }] } }),
      ),
    ).toThrow(/unsupported field/);
    expect(() => parseEngineeringGraphDefinition(loopNode({ loopOptions: { modelEscalationThreshold: 2 } }))).toThrow(
      /requires modelRoutesByFailureCategory/,
    );
    expect(() => parseEngineeringGraphDefinition(loopNode({ budgetWeight: 0 }))).toThrow(/budgetWeight/);
    expect(() => parseEngineeringGraphDefinition(loopNode({ budgetWeight: 1_001 }))).toThrow(/budgetWeight/);
    expect(() => parseEngineeringGraphDefinition(loopNode({ verifierId: "not safe" }))).toThrow(/verifierId/);
    expect(() => parseEngineeringGraphDefinition(loopNode({ outputPaths: ["../escape"] }))).toThrow(/outputPaths/);
    expect(() => parseEngineeringGraphDefinition(loopNode({ outputPaths: [] }))).toThrow(/outputPaths/);
    expect(() => parseEngineeringGraphDefinition(loopNode({ failurePolicy: "skip" }))).toThrow(/failurePolicy/);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "wrong-kind",
        nodes: [{ id: "run", kind: "function", handler: "run", loopOptions: { maxIterations: 2 } }],
      }),
    ).toThrow(/loopOptions require a loop node/);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "wrong-kind",
        nodes: [{ id: "run", kind: "function", handler: "run", outputPaths: ["dist/a.json"] }],
      }),
    ).toThrow(/outputPaths/);
    expect(() =>
      parseEngineeringGraphDefinition({
        graphId: "wrong-kind",
        nodes: [{ id: "run", kind: "function", handler: "run", verifierId: "custom" }],
      }),
    ).toThrow(/verifierId/);
    expect(() =>
      parseEngineeringGraphDefinition({ graphId: "flag", nodes: [{ id: "a", kind: "gate" }], predictiveBudget: 1 }),
    ).toThrow(/predictiveBudget/);
  });

  it("rejects every out-of-bounds Loop option a definition could declare", () => {
    const reject = (loopOptions: unknown, pattern: RegExp): void => {
      expect(() => parseGraphLoopOptions(loopOptions)).toThrow(pattern);
    };
    reject("not an object", /must be an object/);
    reject({ verificationPlan: [] }, /1 to 16 stages/);
    reject({ verificationPlan: [{ id: "a b", command: "true" }] }, /unique safe stage id/);
    reject(
      {
        verificationPlan: [
          { id: "a", command: "true" },
          { id: "a", command: "true" },
        ],
      },
      /unique safe stage id/,
    );
    reject({ verificationPlan: [{ id: "a", command: "  " }] }, /bounded command/);
    reject({ verificationPlan: [{ id: "a", command: "true", cacheable: "yes" }] }, /cacheable must be boolean/);
    reject({ verificationPlan: [{ id: "a", command: "true", paths: [] }] }, /1 to 64 unique prefixes/);
    reject({ verificationPlan: [{ id: "a", command: "true", paths: ["/abs"] }] }, /invalid relative prefix/);
    reject({ verificationPlan: [{ id: "a", command: "true", dependsOn: ["a b"] }] }, /unique safe stage ids/);
    reject({ verificationPlan: [{ id: "a", command: "true", resources: ["not ok"] }] }, /unique safe names/);
    reject({ verificationPlan: [{ id: "a", command: "true", dependsOn: ["missing"] }] }, /unknown stage/);
    reject({ verificationPlan: [{ id: "a", command: "true", timeoutMs: 0 }] }, /timeoutMs/);
    reject({ model: "" }, /bounded non-empty string/);
    reject({ requirementMode: "eventually" }, /requirementMode/);
    reject({ costBudgetUsd: 0 }, /costBudgetUsd/);
    reject({ modelByFailureCategory: { nonsense: "m" } }, /invalid category or model/);
    reject({ modelByFailureCategory: "x" }, /bounded object/);
    reject({ codeReview: "yes" }, /codeReview must be boolean/);
    // The full accepted surface round-trips unchanged.
    const parsed = parseGraphLoopOptions({
      autoVerificationPlan: true,
      maxNoProgressRecoveries: 0,
      rollbackOnRegression: true,
      adaptiveBudget: true,
      maxVerifyRuns: 20,
      verifyTimeoutMs: 1_000,
      agentTimeoutMs: 2_000,
      maxAgentRetries: 0,
      costBudgetUsd: 1.5,
      tokenBudget: 100,
      maxDurationMs: 3_000,
      planModel: "deepseek-reasoner",
      escalateOnFailure: true,
      approveRequirements: true,
    });
    expect(parsed).toEqual({
      autoVerificationPlan: true,
      maxNoProgressRecoveries: 0,
      rollbackOnRegression: true,
      adaptiveBudget: true,
      maxVerifyRuns: 20,
      verifyTimeoutMs: 1_000,
      agentTimeoutMs: 2_000,
      maxAgentRetries: 0,
      costBudgetUsd: 1.5,
      tokenBudget: 100,
      maxDurationMs: 3_000,
      planModel: "deepseek-reasoner",
      escalateOnFailure: true,
      approveRequirements: true,
    });
  });

  it("refuses inputs on a kind that never reads them", () => {
    for (const node of [
      { id: "gate", kind: "gate" },
      { id: "gate", kind: "join" },
      { id: "gate", kind: "wait", waitFor: { signal: "go" } },
    ]) {
      expect(() =>
        parseEngineeringGraphDefinition({
          graphId: "silent-inputs",
          nodes: [
            { id: "source", kind: "function", handler: "source" },
            { ...node, dependsOn: ["source"], inputs: { value: { nodeId: "source" } } },
          ],
        }),
      ).toThrow(/inputs require a kind that consumes them/);
    }
    // A loop node now consumes them, so the same declaration is accepted.
    const accepted = parseEngineeringGraphDefinition({
      graphId: "loop-inputs",
      nodes: [
        { id: "source", kind: "function", handler: "source" },
        {
          id: "repair",
          kind: "loop",
          task: "fix",
          verifyCommand: "true",
          dependsOn: ["source"],
          inputs: { value: { nodeId: "source" } },
        },
      ],
    });
    expect(accepted.nodes[1]?.inputs?.value).toEqual({ nodeId: "source" });
  });

  it("keeps a definition without the new node fields byte-identical for fingerprints", () => {
    // The durable fingerprint is JSON.stringify of the parsed definition, so a
    // definition that predates loopOptions/verifierId/outputPaths/budgetWeight/
    // per-node failurePolicy must still serialize exactly as it did before.
    const legacy = {
      graphId: "legacy",
      nodes: [
        { id: "build", kind: "function", handler: "build", priority: 3 },
        { id: "repair", kind: "loop", task: "fix", verifyCommand: "true", dependsOn: ["build"], timeoutMs: 1_000 },
      ],
      maxConcurrency: 1,
      failurePolicy: "continue",
    };
    const parsed = parseEngineeringGraphDefinition(legacy);
    expect(JSON.stringify(parsed)).toBe(
      JSON.stringify({
        graphId: "legacy",
        nodes: [
          { id: "build", kind: "function", handler: "build", priority: 3 },
          { id: "repair", kind: "loop", dependsOn: ["build"], task: "fix", verifyCommand: "true", timeoutMs: 1_000 },
        ],
        maxConcurrency: 1,
        failurePolicy: "continue",
      }),
    );
    expect(
      graphDefinitionFingerprintMatches(graphDefinitionFingerprint(parsed, new Map()), parsed, parsed, new Map()),
    ).toBe(true);
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

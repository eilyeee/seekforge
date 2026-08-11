import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseEngineeringGraphDefinition } from "../../src/agent/graph-contract.js";
import { planEngineeringGraph } from "../../src/agent/graph-plan.js";
import {
  engineeringGraphFromLoopDag,
  LoopDagGraphConversionError,
  type LoopDagGraphIssueCode,
  type LoopDagGraphSource,
} from "../../src/agent/loop-dag-to-graph.js";
import type { LoopDagNode } from "../../src/agent/loop-dag.js";

const base = { task: "do the work", verifyCommand: "pnpm test" };

function convert(source: LoopDagGraphSource) {
  return engineeringGraphFromLoopDag(source);
}

function blockingCodes(source: LoopDagGraphSource): LoopDagGraphIssueCode[] {
  try {
    convert(source);
  } catch (error) {
    assert.ok(error instanceof LoopDagGraphConversionError, `expected a conversion error, got ${String(error)}`);
    return error.issues.map((issue) => issue.code);
  }
  return [];
}

/** Loop DAG topological layers, computed exactly like the DAG's own readiness rule. */
function loopDagWaves(nodes: readonly LoopDagNode[]): string[][] {
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn ?? [])]));
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    if (ready.length === 0) break;
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const dependencies of remaining.values()) for (const id of ready) dependencies.delete(id);
  }
  return waves;
}

describe("Loop DAG to Engineering Graph conversion", () => {
  test("maps every representable node field onto one loop node", () => {
    const { definition, nodes, warnings } = convert({
      dagId: "release-dag",
      maxConcurrency: 2,
      costBudgetUsd: 4,
      tokenBudget: 90_000,
      maxDurationMs: 600_000,
      managedWorktrees: { integrateDependencies: false },
      managedWorktreeLimit: 12,
      fanIn: { verifyCommand: "pnpm test", maxIterations: 3 },
      nodes: [
        { id: "build", ...base, priority: 4, resources: ["npm"], maxRetries: 2 },
        {
          id: "publish",
          ...base,
          dependsOn: ["build"],
          condition: { nodeId: "build", status: "passed" },
          options: { approvalMode: "confirm" },
        },
      ],
    });

    assert.equal(definition.graphId, "release-dag");
    assert.equal(definition.maxConcurrency, 2);
    assert.equal(definition.costBudgetUsd, 4);
    assert.equal(definition.tokenBudget, 90_000);
    assert.equal(definition.maxDurationMs, 600_000);
    assert.deepEqual(definition.managedWorktrees, { integrateDependencies: false, limit: 12 });
    assert.deepEqual(definition.fanIn, { verifyCommand: "pnpm test", maxIterations: 3 });
    assert.deepEqual(
      definition.nodes.map((node) => node.kind),
      ["loop", "loop"],
    );
    assert.deepEqual(definition.nodes[0], {
      id: "build",
      kind: "loop",
      task: "do the work",
      verifyCommand: "pnpm test",
      priority: 4,
      resources: ["npm"],
      maxRetries: 2,
      // The Loop DAG retries immediately; the Graph always waits, so an
      // equivalent node pins the smallest legal delay.
      retryPolicy: { initialDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterRatio: 0 },
    });
    assert.deepEqual(definition.nodes[1], {
      id: "publish",
      kind: "loop",
      dependsOn: ["build"],
      condition: { nodeId: "build", status: "passed" },
      task: "do the work",
      verifyCommand: "pnpm test",
      approvalMode: "confirm",
    });
    assert.deepEqual(nodes, { build: { loopNodeId: "build" }, publish: { loopNodeId: "publish" } });
    assert.deepEqual(warnings.map((warning) => warning.code).sort(), ["retry_backoff", "scheduling_tiebreak"]);
    // An unbounded Loop DAG worktree count has to become a Graph limit.
    assert.ok(
      convert({ dagId: "unbounded", managedWorktrees: true, nodes: [{ id: "a", ...base }] }).warnings.some(
        (warning) => warning.code === "managed_worktree_limit",
      ),
    );
  });

  test("converts a Loop DAG that uses every previously blocking field", () => {
    const source: LoopDagGraphSource = {
      dagId: "full-coverage",
      maxConcurrency: 2,
      costBudgetUsd: 6,
      tokenBudget: 200_000,
      predictiveBudget: true,
      managedWorktrees: true,
      managedWorktreeLimit: 8,
      nodes: [
        {
          id: "build",
          ...base,
          budgetWeight: 3,
          failurePolicy: "stop",
          outputPaths: ["dist/report.json", "dist/bundle.js"],
          verifierId: "release-verifier",
          options: {
            maxIterations: 12,
            stablePasses: 2,
            flakyRetries: 1,
            maxNoProgressRecoveries: 2,
            rollbackOnRegression: true,
            adaptiveBudget: true,
            codeReview: true,
            escalateOnFailure: true,
            requirementMode: "analyze",
            approveRequirements: true,
            model: "deepseek-chat",
            planModel: "deepseek-reasoner",
            modelByFailureCategory: { test: "deepseek-reasoner" },
            modelRoutesByFailureCategory: { compile: ["deepseek-chat", "deepseek-reasoner"] },
            modelEscalationThreshold: 2,
            maxVerifyRuns: 40,
            verifyTimeoutMs: 120_000,
            agentTimeoutMs: 900_000,
            maxAgentRetries: 2,
            maxDurationMs: 1_800_000,
            costBudgetUsd: 2,
            tokenBudget: 50_000,
            approvalMode: "acceptEdits",
            verificationPlan: [
              { id: "unit", command: "pnpm test", paths: ["packages/core"], cacheable: true },
              { id: "lint", command: "pnpm lint", dependsOn: ["unit"] },
            ],
          },
        },
        {
          id: "publish",
          ...base,
          dependsOn: ["build"],
          budgetWeight: 1,
          consumeDependencyOutputs: true,
        },
      ],
    };
    const { definition, warnings } = convert(source);
    // No blocking issue survives, and the result is a definition the Graph accepts.
    assert.deepEqual(parseEngineeringGraphDefinition(JSON.parse(JSON.stringify(definition)) as unknown), definition);
    assert.equal(definition.predictiveBudget, true);
    const build = definition.nodes[0]!;
    assert.equal(build.budgetWeight, 3);
    assert.equal(build.failurePolicy, "stop");
    assert.equal(build.verifierId, "release-verifier");
    assert.deepEqual(build.outputPaths, ["dist/report.json", "dist/bundle.js"]);
    assert.equal(build.approvalMode, "acceptEdits");
    assert.equal(build.loopOptions?.maxIterations, 12);
    assert.equal(build.loopOptions?.codeReview, true);
    assert.equal(build.loopOptions?.verificationPlan?.length, 2);
    // approvalMode stays on the node; it is never duplicated into loopOptions.
    assert.equal("approvalMode" in (build.loopOptions ?? {}), false);
    assert.deepEqual({ ...definition.nodes[1]!.inputs }, { build: { nodeId: "build" } });
    assert.deepEqual(
      warnings.map((warning) => warning.code).sort(),
      ["dependency_output_shape", "output_path_attestation", "scheduling_tiebreak", "verifier_binding"].sort(),
    );
  });

  test("the exported definition survives a JSON round trip through the Graph parser", () => {
    const { definition } = convert({
      dagId: "round-trip",
      nodes: [
        { id: "a", ...base },
        { id: "b", ...base, dependsOn: ["a"], failurePolicy: "continue" },
        { id: "c", ...base, dependsOn: ["a", "b"], condition: { any: [{ nodeId: "b", status: "failed" }] } },
      ],
    });
    const reparsed = parseEngineeringGraphDefinition(JSON.parse(JSON.stringify(definition)) as unknown);
    assert.deepEqual(reparsed, definition);
  });

  test("maps the per-node failure policy onto conditions and the graph-wide policy", () => {
    const skipDependents = convert({
      dagId: "skip-dependents",
      nodes: [
        { id: "a", ...base },
        { id: "b", ...base, dependsOn: ["a"] },
      ],
    }).definition;
    assert.equal(skipDependents.failurePolicy, "continue");
    // The Graph's own default already skips a node whose dependency did not
    // pass, so `skip_dependents` needs no synthesized condition.
    assert.equal(skipDependents.nodes[1]!.condition, undefined);

    const continuing = convert({
      dagId: "continuing",
      nodes: [
        { id: "a", ...base, failurePolicy: "continue" },
        { id: "gate", ...base },
        { id: "b", ...base, dependsOn: ["a", "gate"] },
      ],
    }).definition;
    assert.deepEqual(continuing.nodes[2]!.condition, {
      all: [
        {
          any: [
            { nodeId: "a", status: "passed" },
            { nodeId: "a", status: "failed" },
          ],
        },
        { nodeId: "gate", status: "passed" },
      ],
    });

    const stopping = convert({
      dagId: "stopping",
      nodes: [
        { id: "a", ...base, failurePolicy: "stop" },
        { id: "b", ...base, dependsOn: ["a"], failurePolicy: "stop" },
      ],
    }).definition;
    assert.equal(stopping.failurePolicy, "continue");
    assert.deepEqual(
      stopping.nodes.map((node) => node.failurePolicy),
      ["stop", "stop"],
    );

    // A subset declaring "stop" is now expressible node by node.
    const mixed = convert({
      dagId: "mixed",
      nodes: [
        { id: "a", ...base, failurePolicy: "stop" },
        { id: "b", ...base, dependsOn: ["a"] },
      ],
    }).definition;
    assert.equal(mixed.failurePolicy, "continue");
    assert.deepEqual(
      mixed.nodes.map((node) => node.failurePolicy),
      ["stop", undefined],
    );
  });

  test("keeps a declared condition authoritative for the dependencies it names", () => {
    const { definition } = convert({
      dagId: "conditional",
      nodes: [
        { id: "probe", ...base },
        { id: "other", ...base },
        {
          id: "repair",
          ...base,
          dependsOn: ["probe", "other"],
          condition: { not: { nodeId: "probe", status: "passed" } },
        },
      ],
    });
    assert.deepEqual(definition.nodes[2]!.condition, {
      all: [{ not: { nodeId: "probe", status: "passed" } }, { nodeId: "other", status: "passed" }],
    });
  });

  test("turns requiresApproval into a gate node the guarded loop observes", () => {
    const { definition, nodes, warnings } = convert({
      dagId: "approval",
      nodes: [
        { id: "prepare", ...base },
        { id: "deploy", ...base, dependsOn: ["prepare"], requiresApproval: true },
      ],
    });
    assert.deepEqual(
      definition.nodes.map((node) => [node.id, node.kind]),
      [
        ["prepare", "loop"],
        ["deploy-approval", "gate"],
        ["deploy", "loop"],
      ],
    );
    assert.deepEqual(definition.nodes[1], { id: "deploy-approval", kind: "gate", dependsOn: ["prepare"] });
    assert.deepEqual(definition.nodes[2]!.dependsOn, ["prepare", "deploy-approval"]);
    assert.deepEqual(definition.nodes[2]!.condition, { nodeId: "deploy-approval", status: "passed" });
    assert.deepEqual(nodes.deploy, { loopNodeId: "deploy", approvalGateId: "deploy-approval" });
    assert.ok(warnings.some((warning) => warning.code === "approval_surface"));
    assert.ok(warnings.some((warning) => warning.code === "approval_pause_scope"));

    // The gate carries the dependency policy so approval is never requested
    // for a node the Loop DAG would have skipped.
    const conditional = convert({
      dagId: "approval-condition",
      nodes: [
        { id: "prepare", ...base },
        {
          id: "deploy",
          ...base,
          dependsOn: ["prepare"],
          requiresApproval: true,
          condition: { nodeId: "prepare", status: "failed" },
        },
      ],
    }).definition;
    assert.deepEqual(conditional.nodes[1]!.condition, { nodeId: "prepare", status: "failed" });

    assert.deepEqual(
      blockingCodes({
        dagId: "approval-collision",
        nodes: [
          { id: "deploy", ...base, requiresApproval: true },
          { id: "deploy-approval", ...base },
        ],
      }),
      ["approval_gate_id"],
    );
  });

  test("refuses every field the Graph cannot represent instead of dropping it", () => {
    // Options the Graph runtime owns still have no node-level equivalent.
    assert.deepEqual(blockingCodes({ dagId: "d", nodes: [{ id: "a", ...base, options: { persist: false } }] }), [
      "node_options_unsupported",
    ]);
    assert.deepEqual(
      blockingCodes({
        dagId: "d",
        nodes: [{ id: "a", ...base, options: { verify: async () => ({ code: 0, output: "" }) } }],
      }),
      ["node_options_unsupported"],
    );
    // Bounds the Graph enforces on the fields it now accepts.
    assert.deepEqual(
      blockingCodes({
        dagId: "d",
        nodes: [{ id: "a", ...base, outputPaths: Array.from({ length: 33 }, (_, index) => `dist/out-${index}.json`) }],
      }),
      ["output_paths"],
    );
    assert.deepEqual(blockingCodes({ dagId: "d", nodes: [{ id: "a", ...base, budgetWeight: 1_001 }] }), [
      "budget_weight",
    ]);
    assert.deepEqual(
      blockingCodes({
        dagId: "d",
        nodes: [
          { id: "1st", ...base },
          { id: "b", ...base, dependsOn: ["1st"], consumeDependencyOutputs: true },
        ],
      }),
      ["consume_dependency_outputs"],
    );
    assert.deepEqual(blockingCodes({ dagId: "d", maxDurationMs: 25 * 60 * 60 * 1000, nodes: [{ id: "a", ...base }] }), [
      "max_duration_range",
    ]);
    assert.deepEqual(
      blockingCodes({ dagId: "d", fanIn: { verifyCommand: "pnpm test" }, nodes: [{ id: "a", ...base }] }),
      ["fan_in_requires_worktrees"],
    );
    assert.deepEqual(blockingCodes({ dagId: "d", maxConcurrency: 2, nodes: [{ id: "a", ...base }] }), [
      "concurrency_isolation",
    ]);
    assert.deepEqual(
      blockingCodes({
        dagId: "d",
        managedWorktrees: true,
        workspaceForNode: { a: "packages/core" },
        nodes: [{ id: "a", ...base }],
      }),
      ["managed_worktree_workspaces"],
    );
    assert.deepEqual(
      blockingCodes({ dagId: "d", workspaceForNode: { missing: "packages/core" }, nodes: [{ id: "a", ...base }] }),
      ["concurrency_isolation"],
    );
    assert.deepEqual(
      blockingCodes({
        dagId: "d",
        nodes: [
          { id: "a", ...base },
          {
            id: "b",
            ...base,
            dependsOn: ["a"],
            outputPaths: Array.from({ length: 33 }, (_, index) => `dist/out-${index}.json`),
            budgetWeight: 5_000,
            options: { persist: false },
          },
        ],
      }),
      ["budget_weight", "node_options_unsupported", "output_paths"],
    );
  });

  test("encodes weighting and predictive reweighting instead of reporting them inert", () => {
    const weighted = convert({
      dagId: "weighted",
      predictiveBudget: true,
      costBudgetUsd: 3,
      nodes: [
        { id: "a", ...base, budgetWeight: 3 },
        { id: "b", ...base, budgetWeight: 1 },
      ],
    });
    assert.equal(weighted.definition.predictiveBudget, true);
    assert.deepEqual(
      weighted.definition.nodes.map((node) => node.budgetWeight),
      [3, 1],
    );
    assert.deepEqual(weighted.warnings, []);
    // An unweighted DAG stays free of the field entirely.
    assert.deepEqual(
      convert({ dagId: "uniform", costBudgetUsd: 3, nodes: [{ id: "a", ...base }] }).definition.nodes[0]!.budgetWeight,
      undefined,
    );
  });

  test("reports run options and a derived identity rather than encoding them silently", () => {
    const warnings = convert({
      workspace: "/repo",
      resume: true,
      persist: false,
      rerunFrom: ["a"],
      nodes: [{ id: "a", ...base }],
    }).warnings;
    assert.deepEqual(warnings.map((warning) => warning.code).sort(), ["graph_identity", "run_option"]);
    assert.match(warnings.find((warning) => warning.code === "run_option")!.field, /workspace, resume, persist/);
  });

  test("derives a deterministic graph id from the definition content", () => {
    const source: LoopDagGraphSource = { nodes: [{ id: "a", ...base }] };
    const first = convert(source).definition.graphId;
    assert.equal(first, convert({ nodes: [{ id: "a", ...base }] }).definition.graphId);
    assert.notEqual(first, convert({ nodes: [{ id: "b", ...base }] }).definition.graphId);
    assert.match(first, /^dag-[0-9a-f]{16}$/);
  });

  test("carries node workspaces through unchanged", () => {
    const { definition } = convert({
      dagId: "workspaces",
      maxConcurrency: 2,
      workspaceForNode: { a: "trees/a", b: "trees/b" },
      nodes: [
        { id: "a", ...base },
        { id: "b", ...base },
      ],
    });
    assert.deepEqual(
      definition.nodes.map((node) => node.workspace),
      ["trees/a", "trees/b"],
    );
  });

  test("plans the same waves as the Loop DAG's own topological layers", () => {
    const nodes: LoopDagNode[] = [
      { id: "lint", ...base },
      { id: "types", ...base },
      { id: "unit", ...base, dependsOn: ["lint", "types"] },
      { id: "e2e", ...base, dependsOn: ["types"], failurePolicy: "continue" },
      { id: "release", ...base, dependsOn: ["unit", "e2e"] },
    ];
    const { definition } = convert({ dagId: "waves", maxConcurrency: 4, managedWorktrees: true, nodes });
    const plan = planEngineeringGraph(definition);
    assert.deepEqual(plan.waves, loopDagWaves(nodes));
    assert.deepEqual(plan.criticalPath, ["lint", "unit", "release"]);
    assert.equal(plan.requiresAgentRuntime, true);
    assert.deepEqual(
      plan.nodes.map((node) => node.priority),
      nodes.map((node) => node.priority ?? 0),
    );
  });

  test("keeps the Loop DAG layering when an approval gate joins its own wave", () => {
    const nodes: LoopDagNode[] = [
      { id: "build", ...base },
      { id: "deploy", ...base, dependsOn: ["build"], requiresApproval: true },
    ];
    const plan = planEngineeringGraph(convert({ dagId: "gated", nodes }).definition);
    // The gate is a synchronous scheduler decision, so it adds a wave without
    // adding work; the Loop nodes keep their relative order.
    assert.deepEqual(plan.waves, [["build"], ["deploy-approval"], ["deploy"]]);
    assert.deepEqual(
      plan.waves.flat().filter((id) => !id.endsWith("-approval")),
      loopDagWaves(nodes).flat(),
    );
  });
});

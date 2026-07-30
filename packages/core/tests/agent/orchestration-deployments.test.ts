import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import { engineeringSubgraphStateId } from "../../src/agent/graph-contract.js";
import { loadEngineeringGraphState, saveEngineeringGraphState } from "../../src/agent/graph-state.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import { acquireLoopLifecycleLease, createLoopState, saveLoopState } from "../../src/agent/loop-state.js";
import { buildWorkspaceOrchestrationReport } from "../../src/agent/orchestration-report.js";
import {
  applyOrchestrationProposal,
  listOrchestrationDeployments,
  observeOrchestrationDeployments,
  rollbackOrchestrationDeployment,
} from "../../src/agent/orchestration-deployments.js";
import {
  graphOrchestrationFingerprint,
  loopOrchestrationFingerprint,
  type OrchestrationProposalDraft,
} from "../../src/agent/orchestration-intelligence.js";
import {
  readWorkspaceOrchestrationIndex,
  refreshWorkspaceOrchestrationIndex,
} from "../../src/agent/orchestration-index.js";
import {
  applyLoopRoutePolicy,
  readAppliedLoopRoutes,
  readWorkspaceOrchestrationSloPolicy,
  setWorkspaceOrchestrationSloPolicy,
} from "../../src/agent/orchestration-policy.js";
import {
  recordOrchestrationProposals,
  setOrchestrationProposalStatus,
} from "../../src/agent/orchestration-proposals.js";

describe("orchestration deployment and policy", () => {
  const workspaces: string[] = [];
  const workspace = () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-orchestration-deploy-"));
    workspaces.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists SLO policy with optimistic concurrency", () => {
    const root = workspace();
    const first = setWorkspaceOrchestrationSloPolicy(
      root,
      { maxP95DurationMs: 1_000, maxFailureRate: 0 },
      { evaluationWindow: 20, maxBreachRate: 0.1 },
    );
    expect(readWorkspaceOrchestrationSloPolicy(root)).toEqual(first);
    const merged = setWorkspaceOrchestrationSloPolicy(root, { maxCostUsd: 2 }, { expectedUpdatedAt: first.updatedAt });
    expect(merged).toMatchObject({
      policy: { maxP95DurationMs: 1_000, maxFailureRate: 0, maxCostUsd: 2 },
      evaluationWindow: 20,
      maxBreachRate: 0.1,
    });
    expect(() =>
      setWorkspaceOrchestrationSloPolicy(root, {}, { expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }),
    ).toThrow(/changed since/);
  });

  it("rejects a persisted route outside the Loop failure taxonomy", () => {
    expect(() =>
      applyLoopRoutePolicy(workspace(), {
        loopId: "route-loop",
        failureCategory: "not-a-category",
        model: "deepseek-chat",
        proposalId: `opt-${"f".repeat(20)}`,
        appliedAt: new Date().toISOString(),
      }),
    ).toThrow(/invalid/);
  });

  it("indexes reachable child Graph checkpoints from external workspaces", async () => {
    const root = workspace();
    mkdirSync(join(root, "child"));
    await runEngineeringGraph(
      {} as AgentCoreDeps,
      {
        graphId: "portfolio-root",
        nodes: [
          {
            id: "child",
            kind: "subgraph",
            workspace: "child",
            graph: { graphId: "child-definition", nodes: [{ id: "work", kind: "function", handler: "work" }] },
          },
        ],
      },
      { workspace: root, handlers: { work: () => ({}) } },
    );
    const childId = engineeringSubgraphStateId("portfolio-root", "child", "child-definition");
    const index = refreshWorkspaceOrchestrationIndex(root);
    expect(index.totals.graphs).toBe(2);
    expect(index.items.map((item) => item.id)).toEqual(expect.arrayContaining(["portfolio-root", childId]));
    const childReport = buildWorkspaceOrchestrationReport(root).graphs.find((graph) => graph.graphId === childId);
    expect(childReport?.replay.events).toBeGreaterThan(0);
  });

  it("applies, observes, and rolls back an exact-generation Loop route", () => {
    const root = workspace();
    const state = createLoopState({
      loopId: "route-loop",
      task: "repair",
      workspace: root,
      verifyCommand: "pnpm test",
      maxIterations: 2,
    });
    saveLoopState(root, state);
    const index = refreshWorkspaceOrchestrationIndex(root);
    expect(index.items).toContainEqual(expect.objectContaining({ kind: "loop", id: state.loopId }));
    expect(readWorkspaceOrchestrationIndex(root)?.generation).toBe(index.generation);
    const draft: OrchestrationProposalDraft = {
      id: `opt-${"1".repeat(20)}`,
      scope: "loop",
      sourceId: state.loopId,
      sourceFingerprint: loopOrchestrationFingerprint(state),
      confidence: "medium",
      evidenceCount: 4,
      risk: "medium",
      title: "Route test failures",
      rationale: "Measured route improves test failures",
      action: { kind: "loop_route", failureCategory: "test", model: "deepseek-chat" },
    };
    const proposal = recordOrchestrationProposals(root, [draft])[0]!;
    const approved = setOrchestrationProposalStatus(root, proposal.id, "approved", proposal.updatedAt);
    applyLoopRoutePolicy(root, {
      loopId: state.loopId,
      failureCategory: "test",
      model: "deepseek-reasoner",
      proposalId: `opt-${"9".repeat(20)}`,
      appliedAt: "2026-01-01T00:00:00.000Z",
    });
    const lifecycleLease = acquireLoopLifecycleLease(root, state.loopId);
    try {
      expect(() => applyOrchestrationProposal(root, proposal.id, { expectedUpdatedAt: approved.updatedAt })).toThrow(
        /already running or being modified/,
      );
    } finally {
      lifecycleLease.release();
    }
    const deployment = applyOrchestrationProposal(root, proposal.id, { expectedUpdatedAt: approved.updatedAt });
    expect(deployment.status).toBe("applied");
    expect(readAppliedLoopRoutes(root, state.loopId)).toEqual({ test: "deepseek-chat" });
    saveLoopState(root, {
      ...state,
      status: "passed",
      iterations: 1,
      lastVerify: { code: 0, output: "ok" },
      updatedAt: new Date(Date.parse(state.updatedAt) + 1_000).toISOString(),
    });
    expect(observeOrchestrationDeployments(root)[0]).toMatchObject({ verdict: "improved" });

    const changed = recordOrchestrationProposals(root, [{ ...draft, rationale: "New evidence changed the draft" }])[0]!;
    expect(changed.status).toBe("proposed");
    expect(listOrchestrationDeployments(root)[0]?.status).toBe("applied");
    const reapproved = setOrchestrationProposalStatus(root, changed.id, "approved", changed.updatedAt);
    expect(() => applyOrchestrationProposal(root, changed.id, { expectedUpdatedAt: reapproved.updatedAt })).toThrow(
      /Rollback the existing applied deployment/,
    );
    const rolledBack = rollbackOrchestrationDeployment(root, proposal.id);
    expect(rolledBack.status).toBe("rolled_back");
    expect(readAppliedLoopRoutes(root, state.loopId)).toEqual({ test: "deepseek-reasoner" });
    writeFileSync(
      join(root, ".seekforge", "orchestration-deployments.json"),
      `${JSON.stringify({
        version: 1,
        deployments: [
          {
            ...rolledBack,
            status: "applied",
            verdict: "pending",
            observed: undefined,
            updatedAt: rolledBack.appliedAt,
            rolledBackAt: undefined,
          },
        ],
      })}\n`,
    );
    expect(rollbackOrchestrationDeployment(root, proposal.id).status).toBe("rolled_back");
  });

  it("refuses to roll back a Loop route that a later deployment superseded", () => {
    const root = workspace();
    const state = createLoopState({
      loopId: "superseded-route",
      task: "repair",
      workspace: root,
      verifyCommand: "pnpm test",
      maxIterations: 2,
    });
    saveLoopState(root, state);
    const draft: OrchestrationProposalDraft = {
      id: `opt-${"3".repeat(20)}`,
      scope: "loop",
      sourceId: state.loopId,
      sourceFingerprint: loopOrchestrationFingerprint(state),
      confidence: "medium",
      evidenceCount: 4,
      risk: "medium",
      title: "Route failures",
      rationale: "Measured route",
      action: { kind: "loop_route", failureCategory: "test", model: "deepseek-chat" },
    };
    const proposal = recordOrchestrationProposals(root, [draft])[0]!;
    const approved = setOrchestrationProposalStatus(root, proposal.id, "approved", proposal.updatedAt);
    applyOrchestrationProposal(root, proposal.id, { expectedUpdatedAt: approved.updatedAt });
    applyLoopRoutePolicy(root, {
      loopId: state.loopId,
      failureCategory: "test",
      model: "newer-model",
      proposalId: `opt-${"4".repeat(20)}`,
      appliedAt: new Date().toISOString(),
    });
    expect(() => rollbackOrchestrationDeployment(root, proposal.id)).toThrow(/changed after deployment/);
    expect(readAppliedLoopRoutes(root, state.loopId)).toEqual({ test: "newer-model" });
  });

  it("transactionally applies and rolls back a Graph policy change", async () => {
    const root = workspace();
    mkdirSync(join(root, "one"));
    mkdirSync(join(root, "two"));
    const state = await runEngineeringGraph(
      {} as AgentCoreDeps,
      {
        graphId: "deploy-graph",
        maxConcurrency: 1,
        nodes: [
          { id: "one", kind: "function", handler: "noop", workspace: "one" },
          { id: "two", kind: "function", handler: "noop", workspace: "two" },
        ],
      },
      { workspace: root, handlers: { noop: () => ({}) } },
    );
    const draft: OrchestrationProposalDraft = {
      id: `opt-${"2".repeat(20)}`,
      scope: "graph",
      sourceId: state.graphId,
      sourceFingerprint: graphOrchestrationFingerprint(state),
      confidence: "high",
      evidenceCount: 10,
      risk: "medium",
      title: "Raise concurrency",
      rationale: "Independent work can overlap",
      action: { kind: "graph_concurrency", value: 2 },
    };
    const proposal = recordOrchestrationProposals(root, [draft])[0]!;
    const approved = setOrchestrationProposalStatus(root, proposal.id, "approved", proposal.updatedAt);
    expect(() =>
      applyOrchestrationProposal(root, proposal.id, {
        expectedUpdatedAt: approved.updatedAt,
        faultInjector: (point) => {
          if (point === "after_target_applied") throw new Error("simulated deployment crash");
        },
      }),
    ).toThrow(/simulated deployment crash/);
    const changed = recordOrchestrationProposals(root, [{ ...draft, rationale: "New deployment evidence" }])[0]!;
    expect(changed.status).toBe("proposed");
    expect(observeOrchestrationDeployments(root)[0]).toMatchObject({
      status: "applied",
      proposalUpdatedAt: approved.updatedAt,
    });
    const reapproved = setOrchestrationProposalStatus(root, changed.id, "approved", changed.updatedAt);
    expect(() => applyOrchestrationProposal(root, changed.id, { expectedUpdatedAt: reapproved.updatedAt })).toThrow(
      /Rollback the existing applied deployment/,
    );
    expect(loadEngineeringGraphState(root, state.graphId)?.definition.maxConcurrency).toBe(2);
    const deployedState = loadEngineeringGraphState(root, state.graphId)!;
    saveEngineeringGraphState(root, {
      ...deployedState,
      priority: deployedState.priority + 1,
      updatedAt: new Date(Date.parse(deployedState.updatedAt) + 1).toISOString(),
    });
    expect(() => rollbackOrchestrationDeployment(root, proposal.id)).toThrow(/changed after deployment/);
    saveEngineeringGraphState(root, deployedState);
    const rollbackFile = join(root, ".seekforge", "orchestration-deployments", `${proposal.id}.rollback.json`);
    writeFileSync(rollbackFile, `${JSON.stringify({ ...state.definition, maxConcurrency: 3 })}\n`);
    expect(() => rollbackOrchestrationDeployment(root, proposal.id)).toThrow(/definition changed/);
    writeFileSync(rollbackFile, `${JSON.stringify(state.definition)}\n`);
    const rolledBack = rollbackOrchestrationDeployment(root, proposal.id);
    expect(rolledBack).toMatchObject({ status: "rolled_back" });
    expect(loadEngineeringGraphState(root, state.graphId)?.definition.maxConcurrency).toBe(1);
    writeFileSync(
      join(root, ".seekforge", "orchestration-deployments.json"),
      `${JSON.stringify({
        version: 1,
        deployments: [
          {
            ...rolledBack,
            status: "applied",
            verdict: "pending",
            updatedAt: rolledBack.appliedAt,
            rolledBackAt: undefined,
          },
        ],
      })}\n`,
    );
    expect(rollbackOrchestrationDeployment(root, proposal.id)).toMatchObject({ status: "rolled_back" });
  });

  it("retries a Graph deployment after a crash before the effect", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      {} as AgentCoreDeps,
      { graphId: "pre-effect-deployment", nodes: [{ id: "one", kind: "function", handler: "noop" }] },
      { workspace: root, handlers: { noop: () => ({}) } },
    );
    const proposal = recordOrchestrationProposals(root, [
      {
        id: `opt-${"6".repeat(20)}`,
        scope: "graph",
        sourceId: state.graphId,
        sourceFingerprint: graphOrchestrationFingerprint(state),
        confidence: "medium",
        evidenceCount: 4,
        risk: "low",
        title: "Raise concurrency",
        rationale: "Exercise intent recovery",
        action: { kind: "graph_concurrency", value: 2 },
      },
    ])[0]!;
    const approved = setOrchestrationProposalStatus(root, proposal.id, "approved", proposal.updatedAt);
    expect(() =>
      applyOrchestrationProposal(root, proposal.id, {
        expectedUpdatedAt: approved.updatedAt,
        faultInjector: (point) => {
          if (point === "after_mark_applying") throw new Error("simulated pre-effect crash");
        },
      }),
    ).toThrow(/simulated pre-effect crash/);
    expect(applyOrchestrationProposal(root, proposal.id, { expectedUpdatedAt: approved.updatedAt })).toMatchObject({
      status: "applied",
      attempt: 2,
    });
  });

  it("recovers an applied executor placement without requiring the executor to remain online", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      {} as AgentCoreDeps,
      {
        graphId: "executor-deployment",
        nodes: [{ id: "ship", kind: "remote", executor: "current" }],
      },
      {
        workspace: root,
        executors: { current: { trusted: true, locality: "remote", execute: () => ({}) } },
      },
    );
    const draft: OrchestrationProposalDraft = {
      id: `opt-${"5".repeat(20)}`,
      scope: "graph",
      sourceId: state.graphId,
      sourceFingerprint: graphOrchestrationFingerprint(state),
      confidence: "medium",
      evidenceCount: 4,
      risk: "medium",
      title: "Move executor",
      rationale: "Measured lower load",
      action: { kind: "executor_placement", nodeId: "ship", executor: "alternate" },
    };
    const proposal = recordOrchestrationProposals(root, [draft])[0]!;
    const approved = setOrchestrationProposalStatus(root, proposal.id, "approved", proposal.updatedAt);
    expect(() =>
      applyOrchestrationProposal(root, proposal.id, {
        expectedUpdatedAt: approved.updatedAt,
        executors: { alternate: { trusted: true, locality: "remote", execute: () => ({}) } },
        faultInjector: (point) => {
          if (point === "after_target_applied") throw new Error("simulated placement crash");
        },
      }),
    ).toThrow(/simulated placement crash/);
    expect(applyOrchestrationProposal(root, proposal.id, { expectedUpdatedAt: approved.updatedAt })).toMatchObject({
      status: "applied",
    });
    expect(loadEngineeringGraphState(root, state.graphId)?.definition.nodes[0]).toMatchObject({
      executor: "alternate",
    });
  });
});

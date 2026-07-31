import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopState, saveLoopState } from "../../src/agent/loop-state.js";
import {
  maintainWorkspaceOrchestration,
  planWorkspaceOrchestrationMaintenance,
} from "../../src/agent/orchestration-maintenance.js";
import { listOrchestrationDeployments } from "../../src/agent/orchestration-deployments.js";
import {
  loopOrchestrationFingerprint,
  type OrchestrationProposalDraft,
} from "../../src/agent/orchestration-intelligence.js";
import {
  listOrchestrationProposals,
  recordOrchestrationProposals,
  setOrchestrationProposalStatus,
} from "../../src/agent/orchestration-proposals.js";
import {
  advanceOrchestrationRollout,
  listOrchestrationRollouts,
  startOrchestrationRollout,
} from "../../src/agent/orchestration-rollouts.js";

const INDEX_PATH = ".seekforge/orchestration-index.json";

/** A terminal Loop whose verification now fails — more failures than the green baseline. */
const regressed = <T extends { updatedAt: string }>(state: T) => ({
  ...state,
  status: "exhausted" as const,
  iterations: 2,
  lastVerify: { code: 1, output: "2 failing" },
  updatedAt: new Date(Date.parse(state.updatedAt) + 1_000).toISOString(),
});

describe("orchestration maintenance", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-maintenance-"));
    workspaces.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Seeds a Loop plus an approved proposal already promoted to a canary rollout.
   * `greenBaseline` captures the deployment baseline from a passing verification,
   * so a later failing verification reads as a regression rather than a recovery.
   */
  const seedCanaryRollout = (root: string, { greenBaseline = false }: { greenBaseline?: boolean } = {}) => {
    const created = createLoopState({
      loopId: "maintenance-loop",
      task: "repair tests",
      workspace: root,
      verifyCommand: "pnpm test",
      maxIterations: 2,
    });
    const state = greenBaseline ? { ...created, iterations: 1, lastVerify: { code: 0, output: "ok" } } : created;
    saveLoopState(root, state);
    const draft: OrchestrationProposalDraft = {
      id: `opt-${"5".repeat(20)}`,
      scope: "loop",
      sourceId: state.loopId,
      sourceFingerprint: loopOrchestrationFingerprint(state),
      confidence: "medium",
      evidenceCount: 4,
      risk: "medium",
      title: "Route test repairs",
      rationale: "Measured evidence",
      action: { kind: "loop_route", failureCategory: "test", model: "deepseek-chat" },
    };
    const proposal = recordOrchestrationProposals(root, [draft])[0]!;
    const approved = setOrchestrationProposalStatus(root, proposal.id, "approved", proposal.updatedAt);
    startOrchestrationRollout(root, proposal.id, { expectedUpdatedAt: approved.updatedAt, minSamples: 1 });
    advanceOrchestrationRollout(root, proposal.id);
    return { state, proposalId: proposal.id };
  };

  it("previews an empty workspace without creating state", () => {
    const root = workspace();
    expect(planWorkspaceOrchestrationMaintenance(root, { autoRollback: true })).toMatchObject({
      proposalsDiscovered: 0,
      activeRollouts: 0,
      indexRefreshRequired: true,
      actions: expect.arrayContaining([expect.stringContaining("rollback enabled")]),
    });
    expect(existsSync(join(root, ".seekforge"))).toBe(false);
  });

  it("materializes the orchestration index for persisted Loops and stays idempotent", () => {
    const root = workspace();
    const state = createLoopState({
      loopId: "indexed-loop",
      task: "keep the suite green",
      workspace: root,
      verifyCommand: "pnpm test",
      maxIterations: 3,
    });
    saveLoopState(root, state);

    const first = maintainWorkspaceOrchestration(root);
    expect(first.index.items).toContainEqual(expect.objectContaining({ kind: "loop", id: "indexed-loop" }));
    expect(first.index.totals.loops).toBe(1);
    expect(first.rollouts).toEqual([]);
    expect(first.controller).toMatchObject({ mode: "active", reason: expect.any(String) });
    expect(existsSync(join(root, INDEX_PATH))).toBe(true);

    const second = maintainWorkspaceOrchestration(root);
    expect(second.index.items).toHaveLength(first.index.items.length);
    expect(second.index.totals).toEqual(first.index.totals);
    const persisted = JSON.parse(readFileSync(join(root, INDEX_PATH), "utf8")) as { items: unknown[] };
    expect(persisted.items).toHaveLength(first.index.items.length);
  });

  it("reconciles an active rollout as part of the background loop", () => {
    const root = workspace();
    const { state, proposalId } = seedCanaryRollout(root);
    saveLoopState(root, {
      ...state,
      status: "passed",
      iterations: 1,
      lastVerify: { code: 0, output: "ok" },
      updatedAt: new Date(Date.parse(state.updatedAt) + 1_000).toISOString(),
    });

    const result = maintainWorkspaceOrchestration(root);

    expect(result.rollouts).toHaveLength(1);
    expect(result.rollouts[0]).toMatchObject({ proposalId, phase: "canary", lastVerdict: "improved" });
    expect(result.rollouts[0]!.stagePercent).toBeGreaterThan(5);
    expect(listOrchestrationRollouts(root)[0]!.stagePercent).toBe(result.rollouts[0]!.stagePercent);
  });

  it("pauses a regressed canary when rollback is not enabled", () => {
    const root = workspace();
    const { state, proposalId } = seedCanaryRollout(root, { greenBaseline: true });
    saveLoopState(root, regressed(state));

    const result = maintainWorkspaceOrchestration(root);

    expect(result.rollouts[0]).toMatchObject({ proposalId, phase: "paused", lastVerdict: "regressed" });
    // Pausing must not touch the proposal: rollback is the only reverting action.
    expect(listOrchestrationProposals(root).find((proposal) => proposal.id === proposalId)).toMatchObject({
      status: "approved",
    });
    // Newly discovered proposals are only ever recorded as drafts to review.
    expect(listOrchestrationProposals(root).filter((proposal) => proposal.id !== proposalId)).toSatisfy(
      (drafts: { status: string }[]) => drafts.every((draft) => draft.status === "proposed"),
    );
    expect(listOrchestrationDeployments(root)[0]).toMatchObject({ status: "applied", verdict: "regressed" });
  });

  it("rolls a regressed canary back when rollback is enabled", () => {
    const root = workspace();
    const { state, proposalId } = seedCanaryRollout(root, { greenBaseline: true });
    saveLoopState(root, regressed(state));

    const result = maintainWorkspaceOrchestration(root, { autoRollback: true });

    expect(result.rollouts[0]).toMatchObject({ proposalId, phase: "rolled_back", lastVerdict: "regressed" });
    expect(listOrchestrationRollouts(root)[0]!.rolledBackAt).toEqual(expect.any(String));
    expect(listOrchestrationDeployments(root)[0]).toMatchObject({ status: "rolled_back" });
  });

  it("reports the same active rollout count that the mutating run reconciles", () => {
    const root = workspace();
    seedCanaryRollout(root);

    const plan = planWorkspaceOrchestrationMaintenance(root);
    expect(plan.activeRollouts).toBe(1);
    expect(plan.actions).toContain("Refresh the materialized orchestration index");
    // Planning is read-only: the index is only materialized by the mutating run.
    expect(existsSync(join(root, INDEX_PATH))).toBe(false);

    expect(maintainWorkspaceOrchestration(root).rollouts).toHaveLength(1);
    expect(existsSync(join(root, INDEX_PATH))).toBe(true);
  });
});

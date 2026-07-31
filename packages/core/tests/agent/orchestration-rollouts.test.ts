import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopState, saveLoopState } from "../../src/agent/loop-state.js";
import {
  loopOrchestrationFingerprint,
  type OrchestrationProposalDraft,
} from "../../src/agent/orchestration-intelligence.js";
import {
  recordOrchestrationProposals,
  setOrchestrationProposalStatus,
} from "../../src/agent/orchestration-proposals.js";
import {
  listOrchestrationDeployments,
  rollbackOrchestrationDeployment,
} from "../../src/agent/orchestration-deployments.js";
import { recordOrchestrationDeploymentObservation } from "../../src/agent/orchestration-control.js";
import { listOrchestrationDecisions } from "../../src/agent/orchestration-decisions.js";
import {
  advanceOrchestrationRollout,
  listOrchestrationRollouts,
  reconcileOrchestrationRollouts,
  recordOrchestrationRolloutSample,
  resumeOrchestrationRollout,
  startOrchestrationRollout,
} from "../../src/agent/orchestration-rollouts.js";

describe("orchestration rollouts", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-rollout-"));
    workspaces.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("moves an approved exact-generation proposal through shadow, canary, and promotion", () => {
    const root = workspace();
    const state = createLoopState({
      loopId: "rollout-loop",
      task: "repair tests",
      workspace: root,
      verifyCommand: "pnpm test",
      maxIterations: 2,
    });
    saveLoopState(root, state);
    const draft: OrchestrationProposalDraft = {
      id: `opt-${"7".repeat(20)}`,
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
    expect(() => startOrchestrationRollout(root, proposal.id, { minSamples: 33 })).toThrow(/minSamples/);
    expect(
      startOrchestrationRollout(root, proposal.id, { expectedUpdatedAt: approved.updatedAt, minSamples: 1 }).phase,
    ).toBe("shadow");
    expect(advanceOrchestrationRollout(root, proposal.id)).toMatchObject({ phase: "canary", stagePercent: 5 });
    saveLoopState(root, {
      ...state,
      status: "passed",
      iterations: 1,
      lastVerify: { code: 0, output: "ok" },
      updatedAt: new Date(Date.parse(state.updatedAt) + 1_000).toISOString(),
    });
    const stage25 = reconcileOrchestrationRollouts(root)[0]!;
    expect(stage25).toMatchObject({
      phase: "canary",
      stagePercent: 25,
      lastVerdict: "improved",
      observationIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    const deployment = listOrchestrationDeployments(root)[0]!;
    const regressionObservation = recordOrchestrationDeploymentObservation(root, {
      ...deployment,
      attempt: deployment.attempt + 1,
      updatedAt: new Date(Date.parse(deployment.updatedAt) + 2_000).toISOString(),
      observed: { ...deployment.observed!, failures: deployment.observed!.failures + 1 },
      verdict: "regressed",
    })!;
    expect(
      recordOrchestrationRolloutSample(root, proposal.id, {
        observationId: regressionObservation.id,
        verdict: regressionObservation.verdict,
      }),
    ).toMatchObject({ phase: "paused", stagePercent: 25 });
    expect(resumeOrchestrationRollout(root, proposal.id)).toMatchObject({
      phase: "canary",
      stagePercent: 25,
      stageObservationIds: [],
      lastVerdict: undefined,
    });
    const recoveryObservation = recordOrchestrationDeploymentObservation(root, {
      ...deployment,
      attempt: deployment.attempt + 2,
      updatedAt: new Date(Date.parse(deployment.updatedAt) + 3_000).toISOString(),
      observed: { ...deployment.observed!, durationPerUnitMs: deployment.observed!.durationPerUnitMs + 1 },
      verdict: "stable",
    })!;
    recordOrchestrationRolloutSample(root, proposal.id, {
      observationId: recoveryObservation.id,
      verdict: recoveryObservation.verdict,
    });
    const promoted = advanceOrchestrationRollout(root, proposal.id);
    expect(promoted).toMatchObject({ phase: "promoted", stagePercent: 100 });
    const gateDecisions = listOrchestrationDecisions(root).filter((decision) => decision.kind === "rollout_gate");
    expect(gateDecisions).toHaveLength(3);
    expect(gateDecisions.every((decision) => decision.selected.includes(proposal.id))).toBe(true);
    rollbackOrchestrationDeployment(root, proposal.id);
    expect(reconcileOrchestrationRollouts(root)[0]).toMatchObject({
      phase: "rolled_back",
      promotedAt: promoted.promotedAt,
    });
    expect(listOrchestrationRollouts(root)).toHaveLength(1);
  });
});

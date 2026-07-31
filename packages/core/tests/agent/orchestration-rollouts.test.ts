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
import { rollbackOrchestrationDeployment } from "../../src/agent/orchestration-deployments.js";
import {
  advanceOrchestrationRollout,
  listOrchestrationRollouts,
  reconcileOrchestrationRollouts,
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
    expect(() => startOrchestrationRollout(root, proposal.id, { minSamples: 2 })).toThrow(/minSamples/);
    expect(startOrchestrationRollout(root, proposal.id, { expectedUpdatedAt: approved.updatedAt }).phase).toBe(
      "shadow",
    );
    expect(advanceOrchestrationRollout(root, proposal.id).phase).toBe("canary");
    saveLoopState(root, {
      ...state,
      status: "passed",
      iterations: 1,
      lastVerify: { code: 0, output: "ok" },
      updatedAt: new Date(Date.parse(state.updatedAt) + 1_000).toISOString(),
    });
    const promoted = reconcileOrchestrationRollouts(root)[0]!;
    expect(promoted).toMatchObject({
      phase: "promoted",
      lastVerdict: "improved",
      observationIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    rollbackOrchestrationDeployment(root, proposal.id);
    expect(reconcileOrchestrationRollouts(root)[0]).toMatchObject({
      phase: "rolled_back",
      promotedAt: promoted.promotedAt,
    });
    expect(listOrchestrationRollouts(root)).toHaveLength(1);
  });
});

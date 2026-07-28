import type { LoopState } from "./loop-state.js";

export type LoopEvidenceReport = {
  schemaVersion: 1;
  loopId: string;
  generatedAt: string;
  status: LoopState["status"];
  workspace: string;
  task: string;
  criteria: Array<{
    id: string;
    text: string;
    requirementIds: string[];
    status: "met" | "unmet" | "unknown";
    evidence: string[];
  }>;
  verification: Array<{
    id: string;
    command: string;
    required: boolean;
    code?: number;
    attempts?: number;
    durationMs?: number;
    flaky?: boolean;
    selection?: "full" | "direct" | "dependency" | "cached";
    matchedPaths?: string[];
  }>;
  iterations: Array<{
    iteration: number;
    ts: string;
    failedTests: number;
    durationMs?: number;
    costUsd?: number;
    tokensUsed?: number;
    failureCategory?: string;
    rolledBack?: boolean;
  }>;
  delivery?: LoopState["delivery"];
};

/** Builds a bounded requirement → verification → immutable delivery evidence view. */
export function buildLoopEvidenceReport(state: LoopState, now = new Date()): LoopEvidenceReport {
  const reviews = new Map(state.acceptanceReview?.criteria.map((criterion) => [criterion.id, criterion]) ?? []);
  const stages = new Map(state.stageResults?.map((stage) => [stage.id, stage]) ?? []);
  const plan = state.verificationPlan ?? [{ id: "verify", command: state.verifyCommand }];
  return {
    schemaVersion: 1,
    loopId: state.loopId,
    generatedAt: now.toISOString(),
    status: state.status,
    workspace: state.workspace,
    task: state.task,
    criteria: (state.requirements?.acceptanceCriteria ?? []).map((criterion) => {
      const review = reviews.get(criterion.id);
      return {
        id: criterion.id,
        text: criterion.text,
        requirementIds: [...criterion.requirementIds],
        status: review?.status ?? "unknown",
        evidence: [...(review?.evidence ?? [])],
      };
    }),
    verification: plan.map((stage) => {
      const result = stages.get(stage.id);
      return {
        id: stage.id,
        command: stage.command,
        required: stage.required !== false,
        ...(result
          ? {
              code: result.code,
              attempts: result.attempts,
              durationMs: result.durationMs,
              flaky: result.flaky,
              ...(result.selection ? { selection: result.selection } : {}),
              ...(result.matchedPaths ? { matchedPaths: [...result.matchedPaths] } : {}),
            }
          : {}),
      };
    }),
    iterations: (state.snapshots ?? []).map((snapshot) => ({
      iteration: snapshot.iteration,
      ts: snapshot.ts,
      failedTests: snapshot.failedTests,
      ...(snapshot.durationMs !== undefined ? { durationMs: snapshot.durationMs } : {}),
      ...(snapshot.costUsd !== undefined ? { costUsd: snapshot.costUsd } : {}),
      ...(snapshot.tokensUsed !== undefined ? { tokensUsed: snapshot.tokensUsed } : {}),
      ...(snapshot.failureCategory ? { failureCategory: snapshot.failureCategory } : {}),
      ...(snapshot.rolledBack ? { rolledBack: true } : {}),
    })),
    ...(state.delivery ? { delivery: state.delivery } : {}),
  };
}

/**
 * Decodes the Desktop SLO policy fields into a `PUT /api/orchestration/policy`
 * body.
 *
 * The route (apps/server/src/routes/orchestration.ts) and core's
 * `setWorkspaceOrchestrationSloPolicy` stay the validator: this turns text into
 * numbers and nothing else. A blank field is omitted so the stored value is
 * kept, and every number the user types is sent exactly as typed — a value the
 * server refuses comes back as the server's own error instead of being clamped,
 * rounded or dropped here, which is how a second rule set starts to drift.
 *
 * The one thing that cannot be deferred is what JSON cannot carry: text that is
 * not a number at all (and ±Infinity, which serializes to null) never reaches
 * the route as the value the user typed, so it is refused here by name.
 */
import type { WorkspaceOrchestrationReport } from "../types";

export const ORCHESTRATION_POLICY_FIELDS = [
  "maxP95DurationMs",
  "maxCostUsd",
  "maxFailureRate",
  "minForecastCoverage",
  "evaluationWindow",
  "maxBreachRate",
] as const;

export type OrchestrationPolicyField = (typeof ORCHESTRATION_POLICY_FIELDS)[number];

/** One text field per policy key; "" means "leave the stored value alone". */
export type OrchestrationPolicyDraft = Record<OrchestrationPolicyField, string>;

export type OrchestrationPolicyUpdate = Partial<Record<OrchestrationPolicyField, number>> & {
  /** Optimistic concurrency: the route refuses the write if the policy moved. */
  expectedUpdatedAt?: string;
};

/** An in-progress edit, pinned to the policy version its fields were filled from. */
export type OrchestrationPolicyEdit = {
  draft: OrchestrationPolicyDraft;
  /** `updatedAt` of the policy the draft started from; absent = there was none. */
  baseUpdatedAt?: string;
};

export const EMPTY_ORCHESTRATION_POLICY_DRAFT: OrchestrationPolicyDraft = {
  maxP95DurationMs: "",
  maxCostUsd: "",
  maxFailureRate: "",
  minForecastCoverage: "",
  evaluationWindow: "",
  maxBreachRate: "",
};

/** Prefills the editor from the policy the breach verdict was computed against. */
export function orchestrationPolicyDraft(
  state: WorkspaceOrchestrationReport["policyState"] | undefined,
): OrchestrationPolicyDraft {
  if (!state) return { ...EMPTY_ORCHESTRATION_POLICY_DRAFT };
  const values: Partial<Record<OrchestrationPolicyField, number | undefined>> = {
    maxP95DurationMs: state.policy.maxP95DurationMs,
    maxCostUsd: state.policy.maxCostUsd,
    maxFailureRate: state.policy.maxFailureRate,
    minForecastCoverage: state.policy.minForecastCoverage,
    evaluationWindow: state.evaluationWindow,
    maxBreachRate: state.maxBreachRate,
  };
  const draft = { ...EMPTY_ORCHESTRATION_POLICY_DRAFT };
  for (const field of ORCHESTRATION_POLICY_FIELDS) {
    const value = values[field];
    if (value !== undefined) draft[field] = String(value);
  }
  return draft;
}

/** Whether the draft differs from what is persisted (nothing to write otherwise). */
export function orchestrationPolicyChanged(
  draft: OrchestrationPolicyDraft,
  state: WorkspaceOrchestrationReport["policyState"] | undefined,
): boolean {
  const persisted = orchestrationPolicyDraft(state);
  return ORCHESTRATION_POLICY_FIELDS.some((field) => draft[field].trim() !== persisted[field]);
}

/**
 * The policy version this save must be checked against: the one the fields were
 * filled from, NOT whatever the latest report happens to hold. A background
 * report reload during an edit would otherwise hand the route a token that
 * matches the newer document, and the concurrent edit would be overwritten by
 * fields prefilled from the older one.
 *
 * The route can only express "expect this version", so an edit that started
 * with no policy at all cannot say "expect none": when one appeared meanwhile,
 * the only non-destructive answer is to refuse here and let the user reload.
 */
export function orchestrationPolicySaveVersion(
  edit: OrchestrationPolicyEdit | undefined,
  state: WorkspaceOrchestrationReport["policyState"] | undefined,
): { expectedUpdatedAt?: string } | { conflict: true } {
  const baseUpdatedAt = edit ? edit.baseUpdatedAt : state?.updatedAt;
  if (baseUpdatedAt === undefined) return state ? { conflict: true } : {};
  return { expectedUpdatedAt: baseUpdatedAt };
}

export function parseOrchestrationPolicyInput(
  draft: OrchestrationPolicyDraft,
  expectedUpdatedAt?: string,
): OrchestrationPolicyUpdate {
  const update: OrchestrationPolicyUpdate = {};
  for (const field of ORCHESTRATION_POLICY_FIELDS) {
    const text = draft[field].trim();
    if (text === "") continue;
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`${field} must be a number`);
    update[field] = value;
  }
  if (expectedUpdatedAt !== undefined) update.expectedUpdatedAt = expectedUpdatedAt;
  return update;
}

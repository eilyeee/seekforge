/**
 * Pure optimistic state transitions for evolution proposals. The view applies
 * these immediately, then reconciles with the server response (or rolls back
 * to the previous list on error).
 */
import type { EvolutionProposal, EvolutionProposalStatus } from "../types";

export type EvolutionAction = "accept" | "reject" | "apply";

const TRANSITIONS: Record<EvolutionAction, { from: EvolutionProposalStatus; to: EvolutionProposalStatus }> = {
  accept: { from: "pending", to: "accepted" },
  reject: { from: "pending", to: "rejected" },
  apply: { from: "accepted", to: "applied" },
};

/**
 * Returns a new list with the proposal transitioned, or null when the
 * transition is invalid (unknown id or wrong current status).
 */
export function transitionProposal(
  proposals: EvolutionProposal[],
  id: string,
  action: EvolutionAction,
): EvolutionProposal[] | null {
  const target = proposals.find((p) => p.id === id);
  const rule = TRANSITIONS[action];
  if (!target || target.status !== rule.from) return null;
  return proposals.map((p) => (p.id === id ? { ...p, status: rule.to } : p));
}

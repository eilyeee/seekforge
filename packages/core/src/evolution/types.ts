/**
 * Self Evolution data model.
 *
 * Evolution only GENERATES candidates: nothing is ever applied without an
 * explicit human accept + apply, and every applied change is plain text the
 * user can review with git diff.
 */

export type EvolutionProposalType = "project_memory" | "agent_rule" | "skill";

export const EVOLUTION_PROPOSAL_TYPES: readonly EvolutionProposalType[] = [
  "project_memory",
  "agent_rule",
  "skill",
];

export type EvolutionProposalRisk = "low" | "medium" | "high";

export type EvolutionProposalStatus = "pending" | "accepted" | "rejected" | "applied";

export type EvolutionProposal = {
  id: string; // ep-<sessionId>-<n>
  sessionId: string;
  type: EvolutionProposalType;
  title: string;
  /** What went wrong / could improve, with evidence. */
  problem: string;
  evidence: { files?: string[]; commands?: string[]; errors?: string[] };
  /** The exact text to apply. skillId only for type "skill". */
  proposal: { content: string; skillId?: string };
  risk: EvolutionProposalRisk;
  status: EvolutionProposalStatus;
  createdAt: string;
  reviewedAt?: string;
};

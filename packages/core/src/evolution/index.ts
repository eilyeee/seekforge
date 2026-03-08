/**
 * Self Evolution module: session scoring, reflection, proposals, apply.
 *
 * Hard boundary: evolution only GENERATES candidates. Nothing is ever
 * applied without an explicit human accept + apply, and every applied
 * change is plain text the user can review with git diff.
 *
 * Storage:
 *   .seekforge/evolution/proposals.jsonl    one EvolutionProposal per line
 *   .seekforge/sessions/<id>/reflection.md  per-session reflection
 */

export {
  EVOLUTION_PROPOSAL_TYPES,
  type EvolutionProposal,
  type EvolutionProposalRisk,
  type EvolutionProposalStatus,
  type EvolutionProposalType,
} from "./types.js";

export {
  appendEvolutionProposals,
  evolutionProposalsPath,
  listEvolutionProposals,
  readEvolutionProposal,
  readEvolutionProposals,
  sessionReflectionPath,
  setEvolutionProposalStatus,
} from "./store.js";

export { scoreSession, type SessionScore, type SessionScoreMetrics } from "./score.js";

export {
  reflectOnSession,
  type ReflectOnSessionInput,
  type ReflectOnSessionResult,
} from "./reflect.js";

export { applyProposal, type ApplyProposalResult } from "./apply.js";

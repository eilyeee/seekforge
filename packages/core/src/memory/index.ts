/**
 * Memory module: project memory, session summaries, memory candidates, brief.
 *
 * Storage (docs/09-memory-system.md): Markdown + JSONL only in this phase.
 *   .seekforge/memory/project.md          long-term approved facts
 *   .seekforge/memory/candidates.jsonl    pending facts awaiting review
 *   .seekforge/sessions/<id>/summary.md   per-session summary
 */

export {
  approveMemoryCandidate,
  candidatesPath,
  formatFactBullet,
  listMemoryCandidates,
  MEMORY_CANDIDATE_TYPES,
  projectMemoryPath,
  readProjectMemory,
  rejectMemoryCandidate,
  sessionSummaryPath,
  type MemoryCandidate,
  type MemoryCandidateType,
} from "./store.js";

export {
  addMemoryFact,
  listProjectFacts,
  removeCandidate,
  removeProjectFact,
  type AddMemoryFactOptions,
  type ProjectFact,
  type ProjectFactSelector,
} from "./direct.js";

export { buildMemoryBrief } from "./brief.js";

export {
  compactProjectMemory,
  computeCompaction,
  type CompactMerge,
  type CompactOptions,
  type CompactResult,
} from "./compact.js";

export {
  extractMemoryFromSession,
  type ExtractMemoryInput,
  type ExtractMemoryResult,
} from "./extract.js";

/**
 * Memory module: project memory, session summaries, memory candidates, brief.
 *
 * Storage (docs/09-memory-system.md): Markdown + JSONL only in this phase.
 *   .seekforge/memory/project.md          long-term approved facts
 *   .seekforge/memory/candidates.jsonl    pending facts awaiting review
 *   .seekforge/sessions/<id>/summary.md   per-session summary
 */

export {
  appendProjectFact,
  approveMemoryCandidate,
  candidatesPath,
  factMetaPath,
  formatFactBullet,
  globalMemoryPath,
  listMemoryCandidates,
  MEMORY_CANDIDATE_TYPES,
  projectMemoryPath,
  readFactMeta,
  readGlobalMemory,
  readProjectMemory,
  readRawProjectMemory,
  readSubdirMemories,
  recordFactAdded,
  recordFactExposure,
  recordFactRetrieval,
  recordFactUse,
  reconcileFactMeta,
  rejectMemoryCandidate,
  seekforgeHome,
  sessionSummaryPath,
  type FactMeta,
  type MemoryCandidate,
  type MemoryCandidateType,
  type SubdirMemory,
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

export {
  ALWAYS_INCLUDE_TYPES,
  buildMemoryBrief,
  parseMemoryBullet,
  rankMemoryBullets,
  RELEVANCE_FLOOR,
  taskKeywords,
  taskPathTokens,
  type MemoryCandidateBullet,
  type RankedMemoryBullet,
} from "./brief.js";

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

export { DIRECT_SOURCE_MARKER, memoryStats, type MemoryStats } from "./stats.js";

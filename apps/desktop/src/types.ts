/**
 * Server API contract types — re-exported from @seekforge/shared, the SINGLE
 * SOURCE OF TRUTH shared by @seekforge/server (producer) and this desktop
 * client (consumer). See apps/server/SERVER-API.md and the "Server API
 * contract" section of packages/shared/src/index.ts.
 *
 * This file used to hand-mirror the server shapes; it is now a thin shim so
 * every existing `../types` import across the desktop keeps resolving unchanged.
 * Add desktop-only UI types here as local declarations (none needed today —
 * every type below is genuinely the server contract).
 */
export type {
  Workspace,
  RecentWorkspace,
  WorkspacesResponse,
  WorktreeCreated,
  WorktreeStatus,
  WorktreeMergeResult,
  SessionMeta,
  SkillScope,
  Skill,
  MemoryCandidateType,
  MemoryCandidate,
  MemoryFact,
  MemoryResponse,
  ServerConfig,
  ConfigKey,
  MemoryStats,
  CompactResult,
  PruneResult,
  DoctorReport,
  AgentScope,
  AgentInfo,
  EvolutionProposalType,
  EvolutionProposalRisk,
  EvolutionProposalStatus,
  EvolutionProposal,
  McpServer,
  McpTool,
  RewindResult,
  SessionTurn,
  BacktrackResult,
  Todo,
  AccountBalance,
  McpResource,
  McpPrompt,
  TreeEntry,
  TreeResponse,
  FileContent,
  GitFileStatus,
  GitFile,
  GitStatus,
  SlashCommand,
  CommandsResponse,
  HookStage,
  HookEntry,
  HooksConfig,
  SearchHit,
  SearchResult,
  LoopStatus,
  LoopResult,
  LoopEvent,
  ModelInfo,
  ApiErrorCode,
} from "@seekforge/shared";

// HOOK_STAGES is a const value (not only a type), so re-export it as a value.
export { HOOK_STAGES } from "@seekforge/shared";

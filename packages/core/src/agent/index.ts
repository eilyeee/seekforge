/**
 * Agent loop: session, context budget, tool-call loop, trace, final report.
 */

import type { AgentEvent, ApprovalMode } from "@seekforge/shared";

export type RunAgentTaskInput = {
  projectPath: string;
  task: string;
  mode: "ask" | "edit";
  /** Plan flavor: read-only investigation producing an implementation plan. */
  plan?: boolean;
  approvalMode: ApprovalMode;
  /** Continue an existing session: replays its messages, appends `task`. */
  resumeSessionId?: string;
  /** Cooperative cancellation (Ctrl+C). Checked between turns and tool calls. */
  signal?: AbortSignal;
  /**
   * Internal: replaces buildSystemPrompt entirely (used by dispatch_agent to
   * give nested subagent runs their own prompt). Not part of the public API.
   */
  systemPromptOverride?: string;
  /** Appended verbatim after the composed system prompt (CLI --append-system-prompt). */
  appendSystemPrompt?: string;
  /** Internal: marks this session as spawned by dispatch_agent (the agent id). */
  parentAgentId?: string;
};

export interface AgentCore {
  runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent>;
}

export {
  createAgentCore,
  createRetryBus,
  hasActiveSessionRuns,
  isSessionRunActive,
  type AgentCoreDeps,
  type RetryBus,
} from "./loop.js";
export {
  buildAgentCoreDeps,
  buildProvider,
  type AgentCoreDepsCommon,
  type BuildAgentCoreDepsExtras,
  type BuildAgentCoreDepsInput,
  type ProviderBuildInput,
} from "./deps-factory.js";
export {
  resumeAutoLoop,
  runAutoLoop,
  type LoopOptions,
  type LoopResult,
  type LoopEvent,
  type LoopStatus,
} from "./auto-loop.js";
export { MAX_LOOP_ITERATIONS } from "./loop-constants.js";
export {
  createLoopState,
  hasActiveLoopLease,
  isLoopLeaseActive,
  isValidLoopId,
  listLoopStates,
  loadLoopState,
  removeLoopState,
  saveLoopState,
  type CreateLoopStateInput,
  type LoopState,
  type LoopVerifyResult,
  type PersistedLoopStatus,
} from "./loop-state.js";
export { classifyAgentError } from "./errors.js";
export type { AgentErrorKind, ClassifiedAgentError } from "./errors.js";
export {
  parseVerifyDiagnostics,
  type VerifyDiagnostic,
  type VerifyDiagnostics,
  type VerifyDiagnosticsOptions,
  type VerifyFramework,
} from "./verify-diagnostics.js";
export { buildSystemPrompt } from "./prompt.js";
export {
  loadUserCommands,
  expandUserCommand,
  commandTakesArguments,
  commandHasShellInjection,
  expandShellInjections,
  buildCommandRoster,
  COMMAND_ARGUMENTS_PLACEHOLDER,
  type UserCommand,
} from "./commands.js";
export { detectThinkingKeyword } from "./thinking.js";
export {
  buildSessionAudit,
  renderSessionAuditMarkdown,
  type SessionAudit,
  type AuditTurn,
  type AuditToolCall,
  type AuditFileChange,
} from "./audit.js";
export {
  OUTPUT_STYLES,
  isOutputStyle,
  outputStylePrompt,
  loadCustomOutputStyle,
  resolveOutputStyle,
  listOutputStyles,
  type OutputStyle,
  type OutputStyleInfo,
} from "./output-style.js";
export { collectProjectRules, collectRuleFiles, type RuleFile } from "./rules.js";
export {
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  llmCompactMessages,
  llmCompactSessionNow,
  type CompactionResult,
  type LlmCompactSessionResult,
  type SummaryProvider,
} from "./context.js";
export {
  appendCheckpoint,
  compactSessionNow,
  createSessionTrace,
  deleteSession,
  forkSession,
  listSessions,
  loadSessionMessages,
  newSessionId,
  pruneSessions,
  readCheckpoints,
  readSessionMeta,
  rewindSession,
  rewindSessionToTurn,
  rewriteSessionMessages,
  sessionTitle,
  truncateSessionAtUserTurn,
  writeSessionMeta,
  type CheckpointEntry,
  type ListSessionsOptions,
  type ManualCompactionResult,
  type PruneResult,
  type PruneSessionsOptions,
  type RewindResult,
  type SessionMeta,
  type TruncateResult,
} from "./trace.js";

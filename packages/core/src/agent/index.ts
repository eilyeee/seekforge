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
  type AgentCoreDeps,
  type RetryBus,
} from "./loop.js";
export {
  acquireSessionLease,
  acquireWorkspaceSessionGuard,
  acquireWorkspaceSessionGuardForLease,
  assertSessionLease,
  hasActiveSessionRuns,
  isSessionRunActive,
  SessionBusyError,
  type SessionLease,
} from "./session-lease.js";
export {
  createMemoryMaintenanceScheduler,
  DEFAULT_MEMORY_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_MEMORY_IDLE_INITIAL_DELAY_MS,
  type IdleMemoryMaintenanceOutcome,
  type IdleMemoryMaintenanceResult,
  type IdleMemoryMaintenanceTarget,
  type MemoryMaintenanceScheduler,
  type MemoryMaintenanceSchedulerOptions,
} from "./memory-idle.js";
export {
  buildAgentCoreDeps,
  buildProvider,
  type AgentCoreDepsCommon,
  type BuildAgentCoreDepsExtras,
  type BuildAgentCoreDepsInput,
  type ProviderBuildInput,
} from "./deps-factory.js";
export {
  createLoopControl,
  type LoopControl,
  type LoopControlState,
} from "./loop-control.js";
export {
  runLoopDag,
  type LoopDagNode,
  type LoopDagNodeResult,
  type LoopDagOptions,
} from "./loop-dag.js";
export {
  resumeAutoLoop,
  autoResumeInterruptedLoops,
  runAutoLoop,
  type LoopOptions,
  type LoopResult,
  type LoopEvent,
  type LoopStatus,
  type LoopBudgetReason,
  type LoopVerificationStage,
  type LoopStageResult,
  type LoopIterationSnapshot,
} from "./auto-loop.js";
export {
  isLoopRequirementMode,
  parseLoopAcceptanceReview,
  parseLoopRequirementSpec,
  validateLoopAcceptanceEvidence,
  type LoopAcceptanceReview,
  type LoopAcceptanceStatus,
  type LoopRequirement,
  type LoopAcceptanceCriterion,
  type LoopRequirementMode,
  type LoopRequirementSpec,
} from "./loop-requirements.js";
export { MAX_LOOP_ITERATIONS } from "./loop-constants.js";
export {
  appendLoopLog,
  createLoopState,
  hasActiveLoopLease,
  isLoopLeaseActive,
  isValidLoopId,
  listLoopStates,
  loadLoopState,
  readLoopHistory,
  recoverInterruptedLoops,
  removeLoopState,
  saveLoopState,
  type CreateLoopStateInput,
  type LoopState,
  type LoopHistoryEntry,
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
  estimateRequestTokens,
  estimateToolDefinitionsTokens,
  estimateTokens,
  llmCompactMessages,
  llmCompactSessionNow,
  selectToolDefinitionsForBudget,
  type CompactionResult,
  type LlmCompactSessionResult,
  type SummaryProvider,
} from "./context.js";
export {
  compactSessionNow,
  createSessionTrace,
  deleteSession,
  listSessions,
  loadSessionMessages,
  newSessionId,
  pruneSessions,
  readSessionMeta,
  rewriteSessionMessages,
  sessionTitle,
  truncateSessionAtUserTurn,
  writeCompactionSnapshot,
  writeSessionMeta,
  type ListSessionsOptions,
  type ManualCompactionResult,
  type PruneResult,
  type PruneSessionsOptions,
  type SessionMeta,
  type TruncateResult,
} from "./trace.js";
export {
  appendCheckpoint,
  forkSession,
  readCheckpoints,
  rewindSession,
  rewindSessionToTurn,
  type CheckpointEntry,
  type RewindResult,
} from "./session-rewind.js";

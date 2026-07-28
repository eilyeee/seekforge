/**
 * Agent loop: session, context budget, tool-call loop, trace, final report.
 */

import type { AgentEvent, ApprovalMode } from "@seekforge/shared";
import type { SessionLease } from "./session-lease.js";

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
  /** Internal: permits this run while its owner holds the workspace idle guard. */
  workspaceGuard?: SessionLease;
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
  acquireSessionLeaseWithPreemption,
  acquireWorkspaceSessionGuard,
  acquireWorkspaceSessionGuardForLease,
  assertSessionLease,
  hasActiveSessionRuns,
  isSessionRunActive,
  isWorkspaceSessionGuardPreemptRequested,
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
  createLoopRecoveryScheduler,
  DEFAULT_LOOP_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_LOOP_IDLE_INITIAL_DELAY_MS,
  type IdleLoopRecoveryOutcome,
  type IdleLoopRecoveryResult,
  type IdleLoopRecoveryTarget,
  type LoopRecoveryScheduler,
  type LoopRecoverySchedulerOptions,
} from "./loop-idle.js";
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
  enqueueLoopControl,
  readLoopControlEntries,
  type DurableLoopControlCommand,
  type DurableLoopControlEntry,
} from "./loop-control-store.js";
export {
  listLoopDagStates,
  loadLoopDagState,
  runLoopDag,
  type LoopDagNode,
  type LoopDagCondition,
  type LoopDagNodeResult,
  type LoopDagNodeOutput,
  type LoopDagOptions,
  type LoopDagFanInResult,
  type PersistedLoopDagState,
} from "./loop-dag.js";
export {
  archiveLoopDagResources,
  inspectLoopDagResources,
  promoteLoopDagResult,
  pruneLoopDagResources,
  type LoopDagResourcePruneResult,
  type LoopDagResourceReport,
} from "./loop-dag-resources.js";
export {
  predictLoopBudgetWeight,
  readLoopBudgetHistory,
  recordLoopBudgetObservation,
  type LoopBudgetObservation,
  type LoopBudgetPrediction,
} from "./loop-budget-history.js";
export {
  resumeAutoLoop,
  autoResumeInterruptedLoops,
  runAutoLoop,
  type LoopOptions,
  type LoopResult,
  type LoopEvent,
  type LoopStatus,
  type LoopBudgetReason,
  type LoopFailureCategory,
  type LoopRecoveryStrategy,
  type LoopVerificationStage,
  type LoopStageResult,
  type LoopVerificationDecision,
  type LoopIterationSnapshot,
} from "./auto-loop.js";
export {
  discoverLoopVerificationPlan,
  type DiscoveredLoopVerificationPlan,
} from "./loop-verification-plan.js";
export {
  buildLoopEvidenceReport,
  compareLoopEvidence,
  exportLoopEvidence,
  verifyLoopEvidenceIntegrity,
  type LoopEvidenceComparison,
  type LoopEvidenceFormat,
  type LoopEvidenceReport,
} from "./loop-evidence.js";
export {
  listLoopSpeculationStates,
  loadLoopSpeculationState,
  promoteLoopSpeculation,
  runSpeculativeLoop,
  type LoopSpeculationCandidate,
  type LoopSpeculationOptions,
  type LoopSpeculationResult,
  type LoopSpeculationState,
} from "./loop-speculation.js";
export {
  defaultLoopRecoveryStrategy,
  explainLoopRecoveryStrategy,
  readLoopRecoveryObservations,
  recordLoopRecoveryObservation,
  selectLoopRecoveryStrategy,
  type LoopRecoveryObservation,
  type LoopRecoveryContext,
  type LoopRecoveryDecision,
} from "./loop-recovery-policy.js";
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
  acquireLoopDeliveryLease,
  acquireLoopLifecycleLease,
  acquireLoopLifecycleLeaseWithPreemption,
  acquireLoopLease,
  appendLoopLog,
  createLoopState,
  hasActiveLoopLease,
  hasCompleteLoopDeliveryEvidence,
  isLoopLeaseActive,
  isLoopDeliveryActive,
  isLoopLifecycleActive,
  isValidLoopId,
  listLoopStates,
  loadLoopState,
  readLoopHistory,
  recoverInterruptedLoops,
  pruneLoopStates,
  recordLoopRecoveryFailure,
  setLoopPriority,
  removeLoopState,
  saveLoopState,
  type CreateLoopStateInput,
  type LoopState,
  type LoopDeliveryMode,
  type LoopDeliveryPhase,
  type LoopDeliveryEvidence,
  type LoopDeliveryCiState,
  type LoopPruneOptions,
  type LoopPruneResult,
  type LoopRecoveryMetadata,
  type LoopDeliveryState,
  type LoopDeliveryStatus,
  type LoopHistoryEntry,
  type LoopLease,
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

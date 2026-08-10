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
  /**
   * Extra bounded execution slices after `maxAgentTurns` is reached. Each
   * slice continues in-memory in the same session without adding a user turn.
   * Default 0 preserves CLI/SDK limit semantics.
   */
  maxAutoContinuations?: number;
  /** Fail early after this many consecutive stagnant tool turns. */
  maxNoProgressTurns?: number;
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
export { createUsageBus, type UsageBus } from "./usage-bus.js";
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
  resolvedPricingSource,
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
  buildLoopCodeReviewPrompt,
  createLoopWorkingMemory,
  formatLoopCodeReviewGaps,
  parseLoopCodeReview,
  parseLoopWorkingMemory,
  type LoopCodeReview,
  type LoopCodeReviewFinding,
  type LoopWorkingMemory,
} from "./loop-code-review.js";
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
  assertLoopDagAcyclic,
  assertValidLoopDagNodes,
  isValidLoopDagId,
  isSafeLoopDagRelativePath,
  loopDagConditionReferences,
  parseLoopDagCondition,
  type LoopDagNode,
  type LoopDagCondition,
  type LoopDagNodeResult,
  type LoopDagNodeOutput,
  type LoopDagOptions,
  type LoopDagFanInResult,
  type PersistedLoopDagState,
} from "./loop-dag.js";
export {
  graphConditionMatches,
  graphConditionReferences,
  graphDefinitionFingerprint,
  graphDefinitionFingerprintMatches,
  graphNodeIsEffectful,
  engineeringGraphNeedsAgentRuntime,
  engineeringSubgraphStateId,
  isValidEngineeringGraphNodePath,
  parseGraphValueSchema,
  parseEngineeringGraphDefinition,
  MAX_GRAPH_CONCURRENCY,
  MAX_GRAPH_RESOURCE_CAPACITIES,
  MAX_GRAPH_RESOURCE_CAPACITY,
  MAX_GRAPH_DEFINITION_BYTES,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  MAX_GRAPH_NODE_TIMEOUT_MS,
  MAX_GRAPH_HISTORY_SEGMENTS,
  type EngineeringGraphDefinition,
  type GraphCondition,
  type GraphInputBinding,
  type GraphNode,
  type GraphNodeKind,
  type GraphNodeStatus,
  type GraphRoute,
  type GraphValueSchema,
  type GraphValueType,
  type GraphRunStatus,
} from "./graph-contract.js";
export {
  runEngineeringGraph,
  resolveEngineeringGraphWorkspaces,
  validateEngineeringGraphRunOptions,
  validateEngineeringGraphWorkspaces,
  type GraphFunctionContext,
  type GraphFunctionHandler,
  type GraphFunctionResult,
  type GraphExecutionAdapter,
  type RunEngineeringGraphOptions,
} from "./graph-engineering.js";
export {
  listEngineeringGraphStates,
  engineeringGraphStateExists,
  loadEngineeringGraphState,
  removeEngineeringGraphState,
  recoverableEngineeringGraphStates,
  recordEngineeringGraphRecoveryFailure,
  clearEngineeringGraphRecovery,
  setEngineeringGraphPriority,
  type EngineeringGraphState,
  type GraphEvent,
  type GraphNodeResult,
  type GraphActiveAttempt,
} from "./graph-state.js";
export {
  enqueueGraphControl,
  readGraphControlEntries,
  type DurableGraphControlCommand,
  type DurableGraphControlEntry,
} from "./graph-control-store.js";
export {
  acknowledgeEngineeringGraphSignal,
  claimEngineeringGraphSignal,
  engineeringGraphSignalAvailable,
  enqueueEngineeringGraphSignal,
  type EngineeringGraphSignal,
} from "./graph-signal-store.js";
export {
  createEngineeringGraphLogWriter,
  engineeringGraphHistoryExists,
  readEngineeringGraphHistory,
  type GraphHistoryEntry,
  type GraphLogWriter,
} from "./graph-history.js";
export {
  buildEngineeringGraphEvidenceReport,
  verifyEngineeringGraphEvidenceIntegrity,
} from "./graph-evidence.js";
export {
  buildEngineeringGraphArtifactCatalog,
  planEngineeringGraphArtifactReuse,
  type EngineeringGraphArtifactCatalogEntry,
  type EngineeringGraphArtifactReuseCandidate,
} from "./graph-artifact-catalog.js";
export {
  engineeringGraphArtifactAvailable,
  inspectEngineeringGraphArtifactStore,
  listEngineeringGraphArtifactAttestations,
  materializeEngineeringGraphArtifact,
  pruneEngineeringGraphArtifactStore,
  storeEngineeringGraphArtifact,
  MAX_GRAPH_ARTIFACT_BYTES,
  type EngineeringGraphArtifactPruneResult,
  type EngineeringGraphArtifactAttestation,
  type EngineeringGraphArtifactAttestationInput,
  type EngineeringGraphArtifactStoreEntry,
} from "./graph-artifact-store.js";
export {
  listEngineeringGraphArtifactTrustKeys,
  listEngineeringGraphArtifactTrustVerifications,
  registerEngineeringGraphArtifactTrustKey,
  revokeEngineeringGraphArtifactTrustKey,
  signEngineeringGraphArtifactAttestation,
  verifyEngineeringGraphArtifactAttestationTrust,
  type EngineeringGraphArtifactProvenance,
  type EngineeringGraphArtifactTrustKey,
  type EngineeringGraphArtifactTrustVerification,
} from "./graph-artifact-trust.js";
export {
  acquireWorkspaceGraphExecutorCapacity,
  listWorkspaceGraphExecutorReservations,
  reconcileWorkspaceGraphExecutorCapacity,
  type WorkspaceGraphExecutorCapacityLease,
  type WorkspaceGraphExecutorCapacityReconcileResult,
  type WorkspaceGraphExecutorReservation,
} from "./graph-capacity.js";
export {
  buildEngineeringGraphRuntimeReplan,
  buildWorkspaceExecutorCapacityReport,
  type EngineeringGraphRuntimeReplan,
  type EngineeringGraphRuntimeReplanEntry,
  type WorkspaceExecutorCapacityEntry,
} from "./graph-runtime-plan.js";
export { BUILTIN_GRAPH_HANDLERS, graphExecutorsWithPlugins, graphHandlersWithPlugins } from "./graph-handlers.js";
export {
  engineeringGraphCriticality,
  planEngineeringGraph,
  type EngineeringGraphPlan,
  type EngineeringGraphPlanNode,
} from "./graph-plan.js";
export {
  compareEngineeringGraphRuns,
  type EngineeringGraphRunComparison,
} from "./graph-observability.js";
export {
  buildEngineeringGraphHealthReport,
  type EngineeringGraphHealthNode,
  type EngineeringGraphHealthReport,
} from "./graph-health.js";
export {
  diagnoseEngineeringGraphCheckpoint,
  diagnoseLoopCheckpoint,
  replayEngineeringGraphHistory,
  replayLoopHistory,
  replayOrchestrationTransitions,
  type OrchestrationDiagnosticIssue,
  type OrchestrationDiagnosticReport,
  type OrchestrationReplayEntry,
  type OrchestrationReplayReport,
} from "./orchestration-diagnostics.js";
export {
  applyEngineeringGraphMigration,
  applyEngineeringGraphExpansion,
  applyEngineeringGraphTreeMigration,
  EngineeringGraphMigrationConflictError,
  planEngineeringGraphMigration,
  planEngineeringGraphExpansion,
  planEngineeringGraphTreeMigration,
  listEngineeringGraphTreeCheckpoints,
  listEngineeringGraphTreeStates,
  listWorkspaceEngineeringGraphTreeCheckpoints,
  listWorkspaceEngineeringGraphTreeStates,
  readEngineeringGraphMigrationJournal,
  readEngineeringGraphTreeMigrationJournal,
  recoverEngineeringGraphTreeMigration,
  type EngineeringGraphMigrationResult,
  type EngineeringGraphMigrationPlan,
  type EngineeringGraphMigrationJournal,
  type EngineeringGraphMigrationOptions,
  type EngineeringGraphTreeMigrationEntry,
  type EngineeringGraphTreeCheckpoint,
  type EngineeringGraphTreeMigrationPlan,
  type EngineeringGraphTreeMigrationJournal,
  type EngineeringGraphTreeMigrationJournalParticipant,
  type EngineeringGraphTreeMigrationOptions,
  type EngineeringGraphTreeMigrationResult,
} from "./graph-migration.js";
export {
  analyzeLoopStrategyIntelligence,
  buildEngineeringGraphOptimizationReport,
  buildLoopOptimizationProposals,
  buildOrchestrationPortfolioReport,
  evaluateOrchestrationSlo,
  graphOrchestrationFingerprint,
  loopOrchestrationFingerprint,
  loopSloObservations,
  type EngineeringGraphOptimizationReport,
  type EngineeringGraphOptimizationScenario,
  type EngineeringGraphPlacement,
  type LoopStrategyIntelligenceReport,
  type LoopStrategyOutcome,
  type OrchestrationConfidence,
  type OrchestrationPortfolioReport,
  type OrchestrationProposalAction,
  type OrchestrationProposalDraft,
  type OrchestrationSloEvaluation,
  type OrchestrationSloPolicy,
} from "./orchestration-intelligence.js";
export {
  isOrchestrationProposalAction,
  listOrchestrationProposals,
  recordOrchestrationProposals,
  setOrchestrationProposalStatus,
  type OrchestrationProposal,
  type OrchestrationProposalStatus,
} from "./orchestration-proposals.js";
export {
  applyOrchestrationProposal,
  listOrchestrationDeployments,
  observeOrchestrationDeployments,
  rollbackOrchestrationDeployment,
  type ApplyOrchestrationProposalOptions,
  type OrchestrationDeployment,
  type OrchestrationDeploymentMetric,
  type OrchestrationDeploymentStatus,
  type OrchestrationDeploymentVerdict,
} from "./orchestration-deployments.js";
export {
  applyLoopRoutePolicy,
  isLoopRoutePolicyApplied,
  readAppliedLoopRoutes,
  readWorkspaceOrchestrationSloPolicy,
  removeLoopRoutePolicy,
  setWorkspaceOrchestrationSloPolicy,
  type AppliedLoopRoute,
  type WorkspaceOrchestrationSloPolicy,
} from "./orchestration-policy.js";
export {
  buildWorkspaceOrchestrationReport,
  type WorkspaceOrchestrationReport,
  type WorkspaceOrchestrationReportOptions,
} from "./orchestration-report.js";
export {
  readWorkspaceOrchestrationIndex,
  refreshWorkspaceOrchestrationIndex,
  type WorkspaceOrchestrationIndex,
  type WorkspaceOrchestrationIndexItem,
} from "./orchestration-index.js";
export {
  buildWorkspaceOrchestrationControlAnalytics,
  listOrchestrationControlObservations,
  recordEngineeringGraphForecastObservation,
  recordOrchestrationDeploymentObservation,
  type OrchestrationBurnRateWindow,
  type OrchestrationCalibrationReport,
  type OrchestrationControlObservation,
  type OrchestrationForecastObservation,
  type WorkspaceOrchestrationControlAnalytics,
} from "./orchestration-control.js";
export {
  completeOrchestrationDecision,
  fingerprintOrchestrationDecisionInput,
  listOrchestrationDecisions,
  readOrchestrationControllerState,
  reconcileOrchestrationController,
  recordOrchestrationDecision,
  resumeOrchestrationController,
  type OrchestrationControllerState,
  type OrchestrationDecision,
} from "./orchestration-decisions.js";
export {
  buildWorkspaceContextualLoopRoutingProfile,
  loopRoutingContext,
  selectWorkspaceContextualLoopRoutes,
  type LoopRoutingContext,
  type WorkspaceContextualLoopRoute,
  type WorkspaceContextualLoopRoutingProfile,
} from "./orchestration-routing.js";
export {
  buildWorkspaceOperationalDiagnostics,
  type WorkspaceOperationalDiagnostics,
} from "./orchestration-operations.js";
export {
  advanceOrchestrationRollout,
  listOrchestrationRollouts,
  pauseOrchestrationRollout,
  recordOrchestrationRolloutSample,
  reconcileOrchestrationRollouts,
  resumeOrchestrationRollout,
  startOrchestrationRollout,
  type OrchestrationRollout,
  type OrchestrationRolloutPhase,
  type OrchestrationRolloutTimelineEntry,
} from "./orchestration-rollouts.js";
export {
  maintainWorkspaceOrchestration,
  planWorkspaceOrchestrationMaintenance,
  type WorkspaceOrchestrationMaintenancePlan,
  type WorkspaceOrchestrationMaintenanceResult,
} from "./orchestration-maintenance.js";
export {
  createOrchestrationMaintenanceScheduler,
  DEFAULT_ORCHESTRATION_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_ORCHESTRATION_IDLE_INITIAL_DELAY_MS,
  type IdleOrchestrationMaintenanceResult,
  type IdleOrchestrationMaintenanceTarget,
  type OrchestrationMaintenanceScheduler,
} from "./orchestration-idle.js";
export {
  explainEngineeringGraphNode,
  simulateEngineeringGraph,
  simulateEngineeringGraphDistribution,
  type EngineeringGraphDistributionEstimate,
  type EngineeringGraphDistributionReport,
  type EngineeringGraphNodeBlocker,
  type EngineeringGraphNodeEstimate,
  type EngineeringGraphNodeExplanation,
  type EngineeringGraphNodeExplanationContext,
  type EngineeringGraphSimulationNode,
  type EngineeringGraphSimulationOptions,
  type EngineeringGraphSimulationReport,
} from "./graph-simulation.js";
export {
  archiveEngineeringGraphRun,
  readEngineeringGraphRunSnapshots,
  type EngineeringGraphRunSnapshot,
} from "./graph-run-history.js";
export {
  analyzeGraphSchedulingIntelligence,
  graphSchedulingScore,
  predictGraphNodeScheduling,
  readGraphSchedulingObservations,
  recordGraphSchedulingObservation,
  summarizeGraphSchedulingIntelligence,
  type GraphSchedulingIntelligence,
  type GraphSchedulingIntelligenceFinding,
  type GraphSchedulingObservation,
} from "./graph-scheduling-history.js";
export {
  DEFAULT_GRAPH_RETRY_POLICY,
  graphRetryDelayMs,
  type GraphRetryPolicy,
} from "./graph-retry-policy.js";
export {
  materializeEngineeringGraph,
  parseEngineeringGraphTemplate,
  type EngineeringGraphTemplate,
  type EngineeringGraphTemplateParameter,
} from "./graph-template.js";
export {
  listEngineeringGraphTemplates,
  compareEngineeringGraphTemplates,
  deprecateEngineeringGraphTemplate,
  registerEngineeringGraphTemplate,
  resolveEngineeringGraphTemplate,
  type RegisteredEngineeringGraphTemplate,
  type EngineeringGraphTemplateCompatibility,
} from "./graph-template-registry.js";
export {
  createGraphMaintenanceScheduler,
  DEFAULT_GRAPH_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_GRAPH_IDLE_INITIAL_DELAY_MS,
  type GraphMaintenanceScheduler,
  type IdleGraphMaintenanceResult,
  type IdleGraphMaintenanceTarget,
} from "./graph-idle.js";
export {
  archiveEngineeringGraphResources,
  inspectEngineeringGraphResources,
  promoteEngineeringGraphResult,
  pruneEngineeringGraphResources,
  pruneEngineeringGraphStates,
  type EngineeringGraphRetentionResult,
  type EngineeringGraphResourcePruneResult,
  type EngineeringGraphResourceReport,
} from "./graph-resources.js";
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
  currentLoopBudgetReason,
  forecastLoopBudgetReason,
  forecastLoopBudgetUsage,
  type LoopBudgetForecast,
  type LoopBudgetLimits,
  type LoopBudgetUsage,
} from "./loop-budget-policy.js";
export {
  isValidOrchestrationResourceId,
  orchestrationResourcesOverlap,
  selectOrchestrationReadyNodes,
  type OrchestrationRunningReservation,
  type OrchestrationScheduleCandidate,
} from "./orchestration-scheduler.js";
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
export { readLoopVerificationCache, recordLoopVerificationCache } from "./loop-verification-cache.js";
export {
  analyzeLoopVerificationIntelligence,
  loopVerificationIntelligenceScore,
  readLoopVerificationIntelligence,
  recordLoopVerificationIntelligence,
  summarizeLoopVerificationReliability,
  type LoopVerificationIntelligence,
  type LoopVerificationIntelligenceFinding,
  type LoopVerificationReliability,
} from "./loop-verification-intelligence.js";
export { buildLoopHealthReport, type LoopHealthFinding, type LoopHealthReport } from "./loop-health.js";
export {
  isLoopFailureCategory,
  selectLoopModelRoute,
  validateLoopModelRoutes,
  type LoopModelRoute,
  type LoopModelRouteReason,
} from "./loop-model-routing.js";
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
  loopStateExists,
  readLoopHistory,
  recoverInterruptedLoops,
  pruneLoopStates,
  clearLoopRecovery,
  recordLoopAutomaticRecoveryFailure,
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
  type LoopAutomaticRecoveryIdentity,
  type LoopPhase,
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
export { astBackendInstalled } from "./repo-map-ast.js";

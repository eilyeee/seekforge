import {
  loadAgentDefinitions,
  loadPluginContributions,
  isValidLoopId,
  runAutoLoop,
  resumeAutoLoop,
  type LoopControl,
  type LoopEvent,
  type LoopResult,
  type LoopRequirementMode,
  type PluginContributions,
  type ToolSpec,
} from "@seekforge/core";
import type { TuiConfig } from "../config.js";
import { expandFileRefs } from "@seekforge/shared/file-refs";
import { buildTuiDeps } from "./factory.js";

export type RunLoopDeps = {
  config: TuiConfig;
  model: string;
  projectPath: string;
  mcpToolSpecs: ToolSpec[];
  pluginContributions?: PluginContributions;
  /** Max run→verify iterations before giving up (caller supplies the default). */
  maxIterations: number;
  /** Optional command-level override; otherwise inherits config.costBudgetUsd. */
  costBudgetUsd?: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  maxVerifyRuns?: number;
  verifyTimeoutMs?: number;
  agentTimeoutMs?: number;
  maxAgentRetries?: number;
  stablePasses?: number;
  flakyRetries?: number;
  maxNoProgressRecoveries?: number;
  rollbackOnRegression?: boolean;
  requirementMode?: LoopRequirementMode;
  control?: LoopControl;
  /** Forwards each LoopEvent to the caller for transcript rendering. */
  onEvent: (event: LoopEvent) => void;
};

/**
 * Drives one autonomous run→verify loop: assembles the SAME agent deps
 * run-session builds (via buildTuiDeps), then hands them to CORE's runAutoLoop.
 * Mirrors run-session.ts but reuses CORE's loop engine instead of driving a
 * single turn.
 *
 * The loop can never stop to ask a human, so it runs in acceptEdits (edits
 * auto-apply) and denies anything else not already permitted (confirm → false),
 * matching the CLI `loop` command and the desktop LoopPanel. Cancellation is
 * cooperative via `signal`.
 */
export async function runLoop(
  task: string,
  verifyCommand: string,
  signal: AbortSignal,
  deps: RunLoopDeps,
): Promise<LoopResult> {
  const pluginContributions = deps.pluginContributions ?? loadPluginContributions(deps.projectPath);
  const { deps: agentDeps, dispose } = buildTuiDeps({
    config: deps.config,
    workspace: deps.projectPath,
    model: deps.model,
    confirm: async () => false,
    extractMemory: true,
    subagents: loadAgentDefinitions(deps.projectPath, pluginContributions),
    mcpToolSpecs: deps.mcpToolSpecs,
    pluginContributions,
  });

  try {
    const costBudgetUsd = deps.costBudgetUsd ?? deps.config.costBudgetUsd;
    return await runAutoLoop(agentDeps, {
      task: expandFileRefs(task, deps.projectPath),
      workspace: deps.projectPath,
      verifyCommand,
      maxIterations: deps.maxIterations,
      ...(costBudgetUsd !== undefined ? { costBudgetUsd } : {}),
      ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
      ...(deps.maxDurationMs !== undefined ? { maxDurationMs: deps.maxDurationMs } : {}),
      ...(deps.maxVerifyRuns !== undefined ? { maxVerifyRuns: deps.maxVerifyRuns } : {}),
      ...(deps.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: deps.verifyTimeoutMs } : {}),
      ...(deps.agentTimeoutMs !== undefined ? { agentTimeoutMs: deps.agentTimeoutMs } : {}),
      ...(deps.maxAgentRetries !== undefined ? { maxAgentRetries: deps.maxAgentRetries } : {}),
      ...(deps.stablePasses !== undefined ? { stablePasses: deps.stablePasses } : {}),
      ...(deps.flakyRetries !== undefined ? { flakyRetries: deps.flakyRetries } : {}),
      ...(deps.maxNoProgressRecoveries !== undefined ? { maxNoProgressRecoveries: deps.maxNoProgressRecoveries } : {}),
      ...(deps.rollbackOnRegression ? { rollbackOnRegression: true } : {}),
      ...(deps.requirementMode !== undefined ? { requirementMode: deps.requirementMode } : {}),
      ...(deps.control ? { control: deps.control } : {}),
      approvalMode: "acceptEdits",
      signal,
      onEvent: deps.onEvent,
    });
  } finally {
    dispose();
  }
}

export async function resumeLoop(
  loopId: string,
  signal: AbortSignal,
  deps: Omit<RunLoopDeps, "maxIterations" | "costBudgetUsd"> & {
    addedIterations?: number;
    addedCostBudgetUsd?: number;
    addedTokenBudget?: number;
    addedDurationMs?: number;
    addedVerifyRuns?: number;
    approveRequirements?: boolean;
  },
): Promise<LoopResult> {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  const pluginContributions = deps.pluginContributions ?? loadPluginContributions(deps.projectPath);
  const { deps: agentDeps, dispose } = buildTuiDeps({
    config: deps.config,
    workspace: deps.projectPath,
    model: deps.model,
    confirm: async () => false,
    extractMemory: true,
    subagents: loadAgentDefinitions(deps.projectPath, pluginContributions),
    mcpToolSpecs: deps.mcpToolSpecs,
    pluginContributions,
  });

  try {
    return await resumeAutoLoop(agentDeps, loopId, {
      workspace: deps.projectPath,
      approvalMode: "acceptEdits",
      signal,
      onEvent: deps.onEvent,
      ...(deps.addedIterations !== undefined ? { additionalIterations: deps.addedIterations } : {}),
      ...(deps.addedCostBudgetUsd !== undefined ? { additionalCostBudgetUsd: deps.addedCostBudgetUsd } : {}),
      ...(deps.addedTokenBudget !== undefined ? { additionalTokenBudget: deps.addedTokenBudget } : {}),
      ...(deps.addedDurationMs !== undefined ? { additionalDurationMs: deps.addedDurationMs } : {}),
      ...(deps.addedVerifyRuns !== undefined ? { additionalVerifyRuns: deps.addedVerifyRuns } : {}),
      ...(deps.approveRequirements !== undefined ? { approveRequirements: deps.approveRequirements } : {}),
      ...(deps.control ? { control: deps.control } : {}),
    });
  } finally {
    dispose();
  }
}

import type { AgentCoreDeps } from "./loop.js";
import { runLoopDag, type LoopDagOptions, type LoopDagNodeResult } from "./loop-dag.js";
import type { LoopOptions } from "./auto-loop.js";

export type LoopSpeculationCandidate = { id: string; guidance: string };
export type LoopSpeculationOptions = {
  workspace: string;
  task: string;
  verifyCommand: string;
  candidates: LoopSpeculationCandidate[];
  /** Speculation is never unbounded: a shared positive cost cap is mandatory. */
  costBudgetUsd: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  maxIterations?: number;
  managedWorktrees?: LoopDagOptions["managedWorktrees"];
  workspaceForCandidate?: (candidate: LoopSpeculationCandidate) => string;
  loopOptions?: Partial<
    Omit<LoopOptions, "task" | "workspace" | "verifyCommand" | "costBudgetUsd" | "tokenBudget" | "maxDurationMs">
  >;
  signal?: AbortSignal;
};

export type LoopSpeculationResult = {
  candidates: LoopDagNodeResult[];
  /** Lowest-cost passing candidate; publishing or merging remains a separate explicit operation. */
  winner?: LoopDagNodeResult;
};

/** Runs two or three bounded repair strategies in physically isolated workspaces. */
export async function runSpeculativeLoop(
  deps: AgentCoreDeps,
  options: LoopSpeculationOptions,
): Promise<LoopSpeculationResult> {
  if (!Array.isArray(options.candidates) || options.candidates.length < 2 || options.candidates.length > 3) {
    throw new RangeError("Loop speculation requires 2 or 3 candidates");
  }
  if (!Number.isFinite(options.costBudgetUsd) || options.costBudgetUsd <= 0) {
    throw new RangeError("Loop speculation requires a positive finite cost budget");
  }
  const ids = new Set<string>();
  for (const candidate of options.candidates) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(candidate.id) || ids.has(candidate.id)) {
      throw new Error(`Loop speculation candidate id must be unique and safe: ${candidate.id}`);
    }
    if (!candidate.guidance.trim() || candidate.guidance.length > 8_192) {
      throw new Error(`Loop speculation candidate guidance is invalid: ${candidate.id}`);
    }
    ids.add(candidate.id);
  }
  if (!options.managedWorktrees && !options.workspaceForCandidate) {
    throw new Error("Loop speculation requires managedWorktrees or workspaceForCandidate isolation");
  }
  const byId = new Map(options.candidates.map((candidate) => [candidate.id, candidate]));
  const results = await runLoopDag(deps, {
    workspace: options.workspace,
    persist: false,
    maxConcurrency: options.candidates.length,
    costBudgetUsd: options.costBudgetUsd,
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
    ...(options.managedWorktrees ? { managedWorktrees: options.managedWorktrees } : {}),
    ...(options.workspaceForCandidate
      ? { workspaceForNode: (node) => options.workspaceForCandidate!(byId.get(node.id)!) }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    nodes: options.candidates.map((candidate) => ({
      id: candidate.id,
      task: `${options.task}\n\nCandidate strategy ${candidate.id}: ${candidate.guidance}`,
      verifyCommand: options.verifyCommand,
      failurePolicy: "continue",
      options: {
        ...options.loopOptions,
        maxIterations: options.maxIterations ?? 2,
        maxNoProgressRecoveries: 0,
      },
    })),
  });
  const winner = results
    .filter((result) => result.status === "passed" && result.result)
    .sort(
      (left, right) =>
        (left.result?.costUsd ?? Number.POSITIVE_INFINITY) - (right.result?.costUsd ?? Number.POSITIVE_INFINITY) ||
        (left.result?.iterations ?? Number.POSITIVE_INFINITY) - (right.result?.iterations ?? Number.POSITIVE_INFINITY),
    )[0];
  return { candidates: results, ...(winner ? { winner } : {}) };
}

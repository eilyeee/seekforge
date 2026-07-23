import { realpathSync } from "node:fs";
import type { AgentCoreDeps } from "./loop.js";
import { runAutoLoop, type LoopOptions, type LoopResult } from "./auto-loop.js";

export type LoopDagNode = {
  id: string;
  task: string;
  verifyCommand: string;
  dependsOn?: string[];
  options?: Partial<
    Omit<LoopOptions, "task" | "workspace" | "verifyCommand" | "signal" | "onEvent" | "resumeState" | "loopId">
  >;
};

export type LoopDagNodeResult = {
  id: string;
  status: "passed" | "failed" | "skipped";
  result?: LoopResult;
  reason?: string;
};

export type LoopDagOptions = {
  workspace: string;
  nodes: LoopDagNode[];
  maxConcurrency?: number;
  costBudgetUsd?: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  workspaceForNode?: (node: LoopDagNode) => string;
  onNodeEvent?: (nodeId: string, event: Parameters<NonNullable<LoopOptions["onEvent"]>>[0]) => void;
};

/** Runs a dependency DAG; concurrency above one requires an isolated workspace per node. */
export async function runLoopDag(deps: AgentCoreDeps, options: LoopDagOptions): Promise<LoopDagNodeResult[]> {
  if (!Array.isArray(options.nodes) || options.nodes.length === 0 || options.nodes.length > 64) {
    throw new Error("Loop DAG must contain 1 to 64 nodes");
  }
  const byId = new Map<string, LoopDagNode>();
  for (const node of options.nodes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(node.id) || byId.has(node.id)) {
      throw new Error(`Loop DAG node id must be unique and safe: ${node.id}`);
    }
    if (!node.task.trim() || !node.verifyCommand.trim()) throw new Error(`Loop DAG node is incomplete: ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of options.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency) || dependency === node.id) {
        throw new Error(`Loop DAG node ${node.id} has invalid dependency: ${dependency}`);
      }
    }
  }
  const concurrency = Math.max(1, Math.min(options.maxConcurrency ?? 1, 8));
  if (concurrency > 1 && !options.workspaceForNode) {
    throw new Error("Concurrent Loop DAG nodes require workspaceForNode isolation");
  }

  const pending = new Set(byId.keys());
  const results = new Map<string, LoopDagNodeResult>();
  let spentCost = 0;
  let spentTokens = 0;
  const startedAt = Date.now();

  while (pending.size > 0) {
    options.signal?.throwIfAborted();
    const blocked = [...pending].filter((id) =>
      (byId.get(id)?.dependsOn ?? []).some((dependency) => results.get(dependency)?.status !== "passed"),
    );
    for (const id of blocked) {
      const dependencies = byId.get(id)?.dependsOn ?? [];
      if (
        dependencies.some(
          (dependency) => results.get(dependency)?.status === "failed" || results.get(dependency)?.status === "skipped",
        )
      ) {
        results.set(id, { id, status: "skipped", reason: "dependency did not pass" });
        pending.delete(id);
      }
    }
    const ready = [...pending]
      .filter((id) =>
        (byId.get(id)?.dependsOn ?? []).every((dependency) => results.get(dependency)?.status === "passed"),
      )
      .slice(0, concurrency);
    if (ready.length === 0) {
      if (pending.size > 0) throw new Error("Loop DAG contains a dependency cycle");
      break;
    }
    const batchWorkspaces = new Map(
      ready.map((id) => {
        const node = byId.get(id)!;
        const workspace = options.workspaceForNode?.(node) ?? options.workspace;
        return [id, realpathSync.native(workspace)] as const;
      }),
    );
    if (new Set(batchWorkspaces.values()).size !== batchWorkspaces.size) {
      throw new Error("Concurrent Loop DAG nodes resolved to the same workspace");
    }
    const budgetDivisor = ready.length;
    const batch = await Promise.all(
      ready.map(async (id): Promise<LoopDagNodeResult> => {
        const node = byId.get(id)!;
        const elapsed = Date.now() - startedAt;
        const remainingCost =
          options.costBudgetUsd === undefined ? undefined : (options.costBudgetUsd - spentCost) / budgetDivisor;
        const remainingTokens =
          options.tokenBudget === undefined
            ? undefined
            : Math.floor((options.tokenBudget - spentTokens) / budgetDivisor);
        const remainingDuration = options.maxDurationMs === undefined ? undefined : options.maxDurationMs - elapsed;
        if (
          (remainingCost !== undefined && remainingCost <= 0) ||
          (remainingTokens !== undefined && remainingTokens <= 0) ||
          (remainingDuration !== undefined && remainingDuration <= 0)
        ) {
          return { id, status: "skipped", reason: "shared DAG budget exhausted" };
        }
        const result = await runAutoLoop(deps, {
          ...node.options,
          task: node.task,
          workspace: batchWorkspaces.get(id)!,
          verifyCommand: node.verifyCommand,
          ...(remainingCost !== undefined ? { costBudgetUsd: remainingCost } : {}),
          ...(remainingTokens !== undefined ? { tokenBudget: Math.floor(remainingTokens) } : {}),
          ...(remainingDuration !== undefined ? { maxDurationMs: Math.floor(remainingDuration) } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onNodeEvent ? { onEvent: (event) => options.onNodeEvent?.(id, event) } : {}),
        });
        return { id, status: result.status === "passed" ? "passed" : "failed", result };
      }),
    );
    for (const result of batch) {
      pending.delete(result.id);
      results.set(result.id, result);
      spentCost += result.result?.costUsd ?? 0;
      spentTokens += result.result?.tokensUsed ?? 0;
    }
  }
  return options.nodes.map(
    (node) => results.get(node.id) ?? { id: node.id, status: "skipped", reason: "not scheduled" },
  );
}

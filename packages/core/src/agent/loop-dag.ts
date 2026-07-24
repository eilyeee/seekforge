import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { AgentCoreDeps } from "./loop.js";
import { runAutoLoop, type LoopOptions, type LoopResult, type LoopStatus } from "./auto-loop.js";
import { acquireSessionLeaseWithPreemption } from "./session-lease.js";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";

export type LoopDagFailurePolicy = "skip_dependents" | "continue" | "stop";

export type LoopDagNode = {
  id: string;
  task: string;
  verifyCommand: string;
  dependsOn?: string[];
  /** Higher-priority ready nodes are scheduled first. */
  priority?: number;
  /** Relative share of remaining cost/token budgets. Default 1. */
  budgetWeight?: number;
  /** Retry node failures or thrown execution errors. Maximum 5. */
  maxRetries?: number;
  /** Handling when this node ultimately fails. Default skip_dependents. */
  failurePolicy?: LoopDagFailurePolicy;
  options?: Partial<
    Omit<LoopOptions, "task" | "workspace" | "verifyCommand" | "signal" | "onEvent" | "resumeState" | "loopId">
  >;
};

export type LoopDagNodeResult = {
  id: string;
  status: "passed" | "failed" | "skipped";
  result?: LoopResult;
  reason?: string;
  attempts?: number;
};

export type LoopDagOptions = {
  workspace: string;
  nodes: LoopDagNode[];
  /** Stable persistence key; defaults to a fingerprint-derived id. */
  dagId?: string;
  /** Resume completed nodes from the persisted DAG checkpoint. */
  resume?: boolean;
  /** Persist scheduler checkpoints. Default true. */
  persist?: boolean;
  maxConcurrency?: number;
  costBudgetUsd?: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  workspaceForNode?: (node: LoopDagNode) => string;
  onNodeEvent?: (nodeId: string, event: Parameters<NonNullable<LoopOptions["onEvent"]>>[0]) => void;
};

type PersistedLoopDagState = {
  schemaVersion: 1;
  dagId: string;
  fingerprint: string;
  spentCost: number;
  spentTokens: number;
  results: LoopDagNodeResult[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

const DAG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DAG_STATE_LIMIT = 1024 * 1024;
const LOOP_STATUSES = new Set<LoopStatus>([
  "passed",
  "exhausted",
  "no_progress",
  "budget",
  "cancelled",
  "verify_error",
  "agent_error",
  "interrupted",
  "requirements_pending",
]);

function dagFingerprint(nodes: readonly LoopDagNode[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        nodes.map((node) => ({
          id: node.id,
          task: node.task,
          verifyCommand: node.verifyCommand,
          dependsOn: [...(node.dependsOn ?? [])].sort(),
          priority: node.priority ?? 0,
          budgetWeight: node.budgetWeight ?? 1,
          maxRetries: node.maxRetries ?? 0,
          failurePolicy: node.failurePolicy ?? "skip_dependents",
          options: node.options,
        })),
      ),
    )
    .digest("hex");
}

function dagStatePath(dagId: string): string {
  if (!DAG_ID_RE.test(dagId)) throw new Error(`Loop DAG id must be safe: ${dagId}`);
  return `.seekforge/loop-dags/${dagId}.json`;
}

function parseLoopResult(value: unknown): LoopResult | null {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !LOOP_STATUSES.has(value.status as LoopStatus) ||
    !Number.isSafeInteger(value.iterations) ||
    (value.iterations as number) < 0 ||
    typeof value.costUsd !== "number" ||
    !Number.isFinite(value.costUsd) ||
    (value.costUsd as number) < 0 ||
    typeof value.sessionId !== "string" ||
    !isRecord(value.finalVerify) ||
    !Number.isInteger(value.finalVerify.code) ||
    typeof value.finalVerify.output !== "string" ||
    value.finalVerify.output.length > 16_384
  )
    return null;
  return value as LoopResult;
}

function parseDagState(raw: string, dagId: string, fingerprint: string): PersistedLoopDagState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.dagId !== dagId ||
    value.fingerprint !== fingerprint ||
    typeof value.spentCost !== "number" ||
    !Number.isFinite(value.spentCost) ||
    value.spentCost < 0 ||
    !Number.isSafeInteger(value.spentTokens) ||
    (value.spentTokens as number) < 0 ||
    !Array.isArray(value.results) ||
    value.results.length > 64 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    (value.completedAt !== undefined &&
      (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))))
  )
    return null;
  const results: LoopDagNodeResult[] = [];
  const ids = new Set<string>();
  for (const item of value.results) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !DAG_ID_RE.test(item.id) ||
      ids.has(item.id) ||
      (item.status !== "passed" && item.status !== "failed" && item.status !== "skipped") ||
      (item.reason !== undefined && (typeof item.reason !== "string" || item.reason.length > 8_192)) ||
      (item.attempts !== undefined && (!Number.isSafeInteger(item.attempts) || (item.attempts as number) <= 0))
    )
      return null;
    const result = item.result === undefined ? undefined : parseLoopResult(item.result);
    if (item.result !== undefined && result === null) return null;
    ids.add(item.id);
    results.push({
      id: item.id,
      status: item.status,
      ...(result ? { result } : {}),
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      ...(typeof item.attempts === "number" ? { attempts: item.attempts } : {}),
    });
  }
  return { ...(value as PersistedLoopDagState), results };
}

function saveDagState(workspace: string, state: PersistedLoopDagState): void {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > DAG_STATE_LIMIT) throw new Error("Loop DAG checkpoint exceeds 1 MiB");
  writeWorkspaceStateFileAtomic(workspace, dagStatePath(state.dagId), serialized);
}

function validateNode(node: LoopDagNode, byId: ReadonlyMap<string, LoopDagNode>): void {
  if (!DAG_ID_RE.test(node.id)) throw new Error(`Loop DAG node id must be unique and safe: ${node.id}`);
  if (!node.task.trim() || !node.verifyCommand.trim()) throw new Error(`Loop DAG node is incomplete: ${node.id}`);
  if (node.task.length > 64 * 1024 || node.verifyCommand.length > 8_192)
    throw new Error(`Loop DAG node is too large: ${node.id}`);
  if (
    node.priority !== undefined &&
    (!Number.isSafeInteger(node.priority) || node.priority < -10 || node.priority > 10)
  )
    throw new Error(`Loop DAG node priority must be -10 to 10: ${node.id}`);
  if (node.budgetWeight !== undefined && (!Number.isFinite(node.budgetWeight) || node.budgetWeight <= 0))
    throw new Error(`Loop DAG node budgetWeight must be positive: ${node.id}`);
  if (
    node.maxRetries !== undefined &&
    (!Number.isSafeInteger(node.maxRetries) || node.maxRetries < 0 || node.maxRetries > 5)
  )
    throw new Error(`Loop DAG node maxRetries must be 0 to 5: ${node.id}`);
  if (
    node.failurePolicy !== undefined &&
    node.failurePolicy !== "skip_dependents" &&
    node.failurePolicy !== "continue" &&
    node.failurePolicy !== "stop"
  )
    throw new Error(`Loop DAG node failurePolicy is invalid: ${node.id}`);
  for (const dependency of node.dependsOn ?? []) {
    if (!byId.has(dependency) || dependency === node.id) {
      throw new Error(`Loop DAG node ${node.id} has invalid dependency: ${dependency}`);
    }
  }
}

function dependencyAllowsContinuation(node: LoopDagNode | undefined, result: LoopDagNodeResult | undefined): boolean {
  return result?.status === "passed" || (result?.status === "failed" && node?.failurePolicy === "continue");
}

/** Runs a durable dependency DAG; concurrency above one requires an isolated workspace per node. */
export async function runLoopDag(deps: AgentCoreDeps, options: LoopDagOptions): Promise<LoopDagNodeResult[]> {
  if (!Array.isArray(options.nodes) || options.nodes.length === 0 || options.nodes.length > 64) {
    throw new Error("Loop DAG must contain 1 to 64 nodes");
  }
  const byId = new Map<string, LoopDagNode>();
  for (const node of options.nodes) {
    if (byId.has(node.id)) throw new Error(`Loop DAG node id must be unique and safe: ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of options.nodes) validateNode(node, byId);
  const concurrency = options.maxConcurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new RangeError("Loop DAG maxConcurrency must be an integer from 1 to 8");
  }
  if (options.costBudgetUsd !== undefined && (!Number.isFinite(options.costBudgetUsd) || options.costBudgetUsd <= 0)) {
    throw new RangeError("Loop DAG costBudgetUsd must be positive and finite");
  }
  if (options.tokenBudget !== undefined && (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget <= 0)) {
    throw new RangeError("Loop DAG tokenBudget must be a positive integer");
  }
  if (options.maxDurationMs !== undefined && (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0)) {
    throw new RangeError("Loop DAG maxDurationMs must be positive and finite");
  }
  if (concurrency > 1 && !options.workspaceForNode) {
    throw new Error("Concurrent Loop DAG nodes require workspaceForNode isolation");
  }
  const fingerprint = dagFingerprint(options.nodes);
  const dagId = options.dagId ?? `dag-${fingerprint.slice(0, 16)}`;
  if (!DAG_ID_RE.test(dagId)) throw new Error(`Loop DAG id must be safe: ${dagId}`);
  const persistenceEnabled = options.persist !== false;
  const lease = persistenceEnabled
    ? await acquireSessionLeaseWithPreemption(options.workspace, `loop-dag-${dagId}`, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
    : undefined;
  try {
    const now = new Date().toISOString();
    let checkpoint: PersistedLoopDagState = {
      schemaVersion: 1,
      dagId,
      fingerprint,
      spentCost: 0,
      spentTokens: 0,
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    if (options.resume && persistenceEnabled) {
      const raw = readWorkspaceStateFile(options.workspace, dagStatePath(dagId), DAG_STATE_LIMIT);
      if (raw === undefined) throw new Error(`Persisted Loop DAG not found: ${dagId}`);
      const restored = parseDagState(raw, dagId, fingerprint);
      if (!restored) throw new Error(`Persisted Loop DAG is invalid or does not match: ${dagId}`);
      checkpoint = restored;
    }
    const results = new Map(checkpoint.results.map((result) => [result.id, result]));
    for (const id of results.keys()) {
      if (!byId.has(id)) throw new Error(`Persisted Loop DAG contains an unknown node: ${id}`);
    }
    const pending = new Set([...byId.keys()].filter((id) => !results.has(id)));
    let spentCost = checkpoint.spentCost;
    let spentTokens = checkpoint.spentTokens;
    const startedAt = Date.now();
    const persist = (completed = false): void => {
      if (!persistenceEnabled) return;
      checkpoint = {
        ...checkpoint,
        spentCost,
        spentTokens,
        results: options.nodes.flatMap((node) => {
          const result = results.get(node.id);
          return result ? [result] : [];
        }),
        updatedAt: new Date().toISOString(),
        ...(completed ? { completedAt: new Date().toISOString() } : {}),
      };
      saveDagState(options.workspace, checkpoint);
    };
    persist(false);

    let stopRequested = false;
    while (pending.size > 0 && !stopRequested) {
      options.signal?.throwIfAborted();
      for (const id of [...pending]) {
        const dependencies = byId.get(id)?.dependsOn ?? [];
        const terminalFailure = dependencies.some((dependency) => {
          const result = results.get(dependency);
          return (
            (result?.status === "failed" || result?.status === "skipped") &&
            !dependencyAllowsContinuation(byId.get(dependency), result)
          );
        });
        if (terminalFailure) {
          results.set(id, { id, status: "skipped", reason: "dependency did not pass" });
          pending.delete(id);
        }
      }
      const ready = [...pending]
        .filter((id) =>
          (byId.get(id)?.dependsOn ?? []).every((dependency) =>
            dependencyAllowsContinuation(byId.get(dependency), results.get(dependency)),
          ),
        )
        .sort((left, right) => (byId.get(right)?.priority ?? 0) - (byId.get(left)?.priority ?? 0))
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
      const totalWeight = ready.reduce((sum, id) => sum + (byId.get(id)?.budgetWeight ?? 1), 0);
      const batch = await Promise.all(
        ready.map(async (id): Promise<LoopDagNodeResult> => {
          const node = byId.get(id)!;
          const weightShare = (node.budgetWeight ?? 1) / totalWeight;
          const elapsed = Date.now() - startedAt;
          const remainingCost =
            options.costBudgetUsd === undefined ? undefined : (options.costBudgetUsd - spentCost) * weightShare;
          const remainingTokens =
            options.tokenBudget === undefined
              ? undefined
              : Math.floor((options.tokenBudget - spentTokens) * weightShare);
          const remainingDuration = options.maxDurationMs === undefined ? undefined : options.maxDurationMs - elapsed;
          if (
            (remainingCost !== undefined && remainingCost <= 0) ||
            (remainingTokens !== undefined && remainingTokens <= 0) ||
            (remainingDuration !== undefined && remainingDuration <= 0)
          ) {
            return { id, status: "skipped", reason: "shared DAG budget exhausted", attempts: 1 };
          }
          let lastResult: LoopResult | undefined;
          let lastError: unknown;
          let nodeCost = 0;
          let nodeTokens = 0;
          let attemptsExecuted = 0;
          const maxAttempts = (node.maxRetries ?? 0) + 1;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            options.signal?.throwIfAborted();
            try {
              const attemptCost = remainingCost === undefined ? undefined : remainingCost - nodeCost;
              const attemptTokens = remainingTokens === undefined ? undefined : remainingTokens - nodeTokens;
              const attemptDuration =
                options.maxDurationMs === undefined ? undefined : options.maxDurationMs - (Date.now() - startedAt);
              if (
                (attemptCost !== undefined && attemptCost <= 0) ||
                (attemptTokens !== undefined && attemptTokens <= 0) ||
                (attemptDuration !== undefined && attemptDuration <= 0)
              )
                break;
              attemptsExecuted = attempt;
              lastResult = await runAutoLoop(deps, {
                ...node.options,
                task: node.task,
                workspace: batchWorkspaces.get(id)!,
                verifyCommand: node.verifyCommand,
                priority: node.priority ?? 0,
                ...(attemptCost !== undefined ? { costBudgetUsd: attemptCost } : {}),
                ...(attemptTokens !== undefined ? { tokenBudget: attemptTokens } : {}),
                ...(attemptDuration !== undefined ? { maxDurationMs: Math.floor(attemptDuration) } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
                ...(options.onNodeEvent ? { onEvent: (event) => options.onNodeEvent?.(id, event) } : {}),
              });
              nodeCost += lastResult.costUsd;
              nodeTokens += lastResult.tokensUsed ?? 0;
              const cumulativeResult = { ...lastResult, costUsd: nodeCost, tokensUsed: nodeTokens };
              if (lastResult.status === "passed") {
                return { id, status: "passed", result: cumulativeResult, attempts: attempt };
              }
              lastResult = cumulativeResult;
              lastError = new Error(`Loop ended with status ${lastResult.status}`);
            } catch (error) {
              if (options.signal?.aborted) throw error;
              lastError = error;
            }
          }
          return {
            id,
            status: "failed",
            ...(lastResult ? { result: lastResult } : {}),
            reason:
              attemptsExecuted === 0
                ? "shared DAG budget exhausted"
                : lastError instanceof Error
                  ? lastError.message.slice(0, 8_192)
                  : String(lastError).slice(0, 8_192),
            attempts: Math.max(1, attemptsExecuted),
          };
        }),
      );
      for (const result of batch) {
        pending.delete(result.id);
        results.set(result.id, result);
        spentCost += result.result?.costUsd ?? 0;
        spentTokens += result.result?.tokensUsed ?? 0;
        if (result.status === "failed" && byId.get(result.id)?.failurePolicy === "stop") stopRequested = true;
      }
      persist(false);
    }
    if (stopRequested) {
      for (const id of pending) results.set(id, { id, status: "skipped", reason: "DAG stopped after node failure" });
      pending.clear();
    }
    persist(true);
    return options.nodes.map(
      (node) => results.get(node.id) ?? { id: node.id, status: "skipped", reason: "not scheduled" },
    );
  } finally {
    lease?.release();
  }
}

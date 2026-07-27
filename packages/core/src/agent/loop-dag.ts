import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { AgentCoreDeps } from "./loop.js";
import { runAutoLoop, type LoopOptions, type LoopResult, type LoopStatus } from "./auto-loop.js";
import { acquireSessionLeaseWithPreemption } from "./session-lease.js";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";

export type LoopDagFailurePolicy = "skip_dependents" | "continue" | "stop";
export type LoopDagCondition = { nodeId: string; status: "passed" | "failed" };
export type LoopDagNodeOutput = {
  status: LoopResult["status"];
  loopId?: string;
  sessionId: string;
  costUsd: number;
  tokensUsed: number;
  iterations: number;
};

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
  /** Run only when this dependency finished with the requested scheduler status. */
  condition?: LoopDagCondition;
  /** Named exclusive resources; ready nodes sharing one are serialized. */
  resources?: string[];
  /** Pause at this node until the embedding surface explicitly approves it. */
  requiresApproval?: boolean;
  /** Include bounded structured dependency outputs in this node's task. */
  consumeDependencyOutputs?: boolean;
  /** Stable identity for a custom options.verify implementation across durable resumes. */
  verifierId?: string;
  options?: Partial<
    Omit<LoopOptions, "task" | "workspace" | "verifyCommand" | "signal" | "onEvent" | "resumeState" | "loopId">
  >;
};

export type LoopDagNodeResult = {
  id: string;
  status: "passed" | "failed" | "skipped" | "waiting_approval";
  result?: LoopResult;
  output?: LoopDagNodeOutput;
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
  /** Nodes to invalidate together with every downstream dependent when resuming. */
  rerunFrom?: string[];
  approveNode?: (node: LoopDagNode, completed: ReadonlyMap<string, LoopDagNodeResult>) => boolean | Promise<boolean>;
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

function dagFingerprint(nodes: readonly LoopDagNode[], workspaces: ReadonlyMap<string, string>): string {
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
          condition: node.condition,
          resources: [...(node.resources ?? [])].sort(),
          requiresApproval: node.requiresApproval ?? false,
          consumeDependencyOutputs: node.consumeDependencyOutputs ?? false,
          verifierId: node.verifierId,
          workspace: workspaces.get(node.id),
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
      (item.status !== "passed" &&
        item.status !== "failed" &&
        item.status !== "skipped" &&
        item.status !== "waiting_approval") ||
      (item.reason !== undefined && (typeof item.reason !== "string" || item.reason.length > 8_192)) ||
      (item.attempts !== undefined && (!Number.isSafeInteger(item.attempts) || (item.attempts as number) <= 0))
    )
      return null;
    const result = item.result === undefined ? undefined : parseLoopResult(item.result);
    if (item.result !== undefined && result === null) return null;
    ids.add(item.id);
    const outputValue = item.output;
    const output =
      isRecord(outputValue) &&
      LOOP_STATUSES.has(outputValue.status as LoopStatus) &&
      typeof outputValue.sessionId === "string" &&
      typeof outputValue.costUsd === "number" &&
      Number.isFinite(outputValue.costUsd) &&
      outputValue.costUsd >= 0 &&
      Number.isSafeInteger(outputValue.tokensUsed) &&
      (outputValue.tokensUsed as number) >= 0 &&
      Number.isSafeInteger(outputValue.iterations) &&
      (outputValue.iterations as number) >= 0 &&
      (outputValue.loopId === undefined || typeof outputValue.loopId === "string")
        ? (outputValue as LoopDagNodeOutput)
        : undefined;
    if (item.output !== undefined && output === undefined) return null;
    results.push({
      id: item.id,
      status: item.status,
      ...(result ? { result } : {}),
      ...(output ? { output } : {}),
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
  if (node.verifierId !== undefined && !DAG_ID_RE.test(node.verifierId)) {
    throw new Error(`Loop DAG node verifierId must be safe: ${node.id}`);
  }
  if (
    node.condition !== undefined &&
    (!DAG_ID_RE.test(node.condition.nodeId) ||
      (node.condition.status !== "passed" && node.condition.status !== "failed") ||
      !(node.dependsOn ?? []).includes(node.condition.nodeId))
  ) {
    throw new Error(`Loop DAG node condition must reference one of its dependencies: ${node.id}`);
  }
  if (
    node.resources !== undefined &&
    (!Array.isArray(node.resources) ||
      node.resources.length === 0 ||
      node.resources.length > 32 ||
      new Set(node.resources).size !== node.resources.length ||
      node.resources.some((resource) => !DAG_ID_RE.test(resource)))
  ) {
    throw new Error(`Loop DAG node resources must be unique safe names: ${node.id}`);
  }
  if (node.requiresApproval !== undefined && typeof node.requiresApproval !== "boolean") {
    throw new Error(`Loop DAG node requiresApproval must be boolean: ${node.id}`);
  }
  if (node.consumeDependencyOutputs !== undefined && typeof node.consumeDependencyOutputs !== "boolean") {
    throw new Error(`Loop DAG node consumeDependencyOutputs must be boolean: ${node.id}`);
  }
  for (const dependency of node.dependsOn ?? []) {
    if (!byId.has(dependency) || dependency === node.id) {
      throw new Error(`Loop DAG node ${node.id} has invalid dependency: ${dependency}`);
    }
  }
}

function dependencyAllowsContinuation(node: LoopDagNode | undefined, result: LoopDagNodeResult | undefined): boolean {
  return result?.status === "passed" || (result?.status === "failed" && node?.failurePolicy === "continue");
}

function dependencyAllowsNode(
  node: LoopDagNode,
  dependency: string,
  dependencyNode: LoopDagNode | undefined,
  result: LoopDagNodeResult | undefined,
): boolean {
  if (node.condition?.nodeId === dependency) return result?.status === node.condition.status;
  return dependencyAllowsContinuation(dependencyNode, result);
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
  if (
    options.maxDurationMs !== undefined &&
    (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs <= 0)
  ) {
    throw new RangeError("Loop DAG maxDurationMs must be a positive safe integer");
  }
  if (concurrency > 1 && !options.workspaceForNode) {
    throw new Error("Concurrent Loop DAG nodes require workspaceForNode isolation");
  }
  if (options.rerunFrom !== undefined) {
    if (!options.resume) throw new Error("Loop DAG rerunFrom requires resume");
    if (
      !Array.isArray(options.rerunFrom) ||
      options.rerunFrom.length === 0 ||
      new Set(options.rerunFrom).size !== options.rerunFrom.length ||
      options.rerunFrom.some((id) => !byId.has(id))
    ) {
      throw new Error("Loop DAG rerunFrom must contain unique existing node ids");
    }
  }
  const persistenceEnabled = options.persist !== false;
  for (const node of options.nodes) {
    if (persistenceEnabled && node.options?.verify && node.verifierId === undefined) {
      throw new Error(`Persisted Loop DAG node with a custom verifier requires verifierId: ${node.id}`);
    }
  }
  const nodeWorkspaces = new Map(
    options.nodes.map((node) => [node.id, realpathSync.native(options.workspaceForNode?.(node) ?? options.workspace)]),
  );
  if (concurrency > 1 && new Set(nodeWorkspaces.values()).size !== nodeWorkspaces.size) {
    throw new Error("Concurrent Loop DAG nodes must resolve to distinct workspaces");
  }
  const fingerprint = dagFingerprint(options.nodes, nodeWorkspaces);
  const dagId = options.dagId ?? `dag-${fingerprint.slice(0, 16)}`;
  if (!DAG_ID_RE.test(dagId)) throw new Error(`Loop DAG id must be safe: ${dagId}`);
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
    for (const [id, result] of results) {
      if (result.status === "waiting_approval") results.delete(id);
    }
    if (options.rerunFrom?.length) {
      const invalidated = new Set(options.rerunFrom);
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of options.nodes) {
          if (!invalidated.has(node.id) && (node.dependsOn ?? []).some((dependency) => invalidated.has(dependency))) {
            invalidated.add(node.id);
            changed = true;
          }
        }
      }
      for (const id of invalidated) results.delete(id);
    }
    const pending = new Set([...byId.keys()].filter((id) => !results.has(id)));
    let spentCost = [...results.values()].reduce((sum, result) => sum + (result.result?.costUsd ?? 0), 0);
    let spentTokens = [...results.values()].reduce((sum, result) => sum + (result.result?.tokensUsed ?? 0), 0);
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
        completedAt: completed ? new Date().toISOString() : undefined,
      };
      saveDagState(options.workspace, checkpoint);
    };
    persist(false);

    let stopRequested = false;
    let approvalPending = false;
    while (pending.size > 0 && !stopRequested) {
      options.signal?.throwIfAborted();
      for (const id of [...pending]) {
        const node = byId.get(id)!;
        if (node.condition) {
          const conditionResult = results.get(node.condition.nodeId);
          if (
            conditionResult &&
            conditionResult.status !== "waiting_approval" &&
            conditionResult.status !== node.condition.status
          ) {
            results.set(id, { id, status: "skipped", reason: "condition not met" });
            pending.delete(id);
            continue;
          }
        }
        const dependencies = node.dependsOn ?? [];
        const terminalFailure = dependencies.some((dependency) => {
          const result = results.get(dependency);
          return (
            (result?.status === "failed" || result?.status === "skipped") &&
            !dependencyAllowsNode(node, dependency, byId.get(dependency), result)
          );
        });
        if (terminalFailure) {
          results.set(id, { id, status: "skipped", reason: "dependency did not pass" });
          pending.delete(id);
        }
      }
      const candidates = [...pending]
        .filter((id) =>
          (byId.get(id)?.dependsOn ?? []).every((dependency) => {
            const node = byId.get(id)!;
            return dependencyAllowsNode(node, dependency, byId.get(dependency), results.get(dependency));
          }),
        )
        .sort((left, right) => (byId.get(right)?.priority ?? 0) - (byId.get(left)?.priority ?? 0));
      const ready: string[] = [];
      const reservedResources = new Set<string>();
      const reservedWorkspaces = new Set<string>();
      for (const id of candidates) {
        const node = byId.get(id)!;
        const workspace = nodeWorkspaces.get(id)!;
        if (
          reservedWorkspaces.has(workspace) ||
          (node.resources ?? []).some((resource) => reservedResources.has(resource))
        ) {
          continue;
        }
        ready.push(id);
        reservedWorkspaces.add(workspace);
        for (const resource of node.resources ?? []) reservedResources.add(resource);
        if (ready.length === concurrency) break;
      }
      if (ready.length === 0) {
        if ([...results.values()].some((result) => result.status === "waiting_approval")) {
          approvalPending = true;
          persist(false);
          break;
        }
        if (pending.size > 0) throw new Error("Loop DAG contains a dependency cycle");
        break;
      }
      for (const id of [...ready]) {
        const node = byId.get(id)!;
        if (!node.requiresApproval) continue;
        const approved = (await options.approveNode?.(node, results)) === true;
        if (approved) continue;
        results.set(id, { id, status: "waiting_approval", reason: "explicit approval required" });
        pending.delete(id);
        ready.splice(ready.indexOf(id), 1);
        approvalPending = true;
      }
      if (ready.length === 0 && approvalPending) {
        persist(false);
        break;
      }
      const batchWorkspaces = new Map(ready.map((id) => [id, nodeWorkspaces.get(id)!] as const));
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
                task:
                  node.consumeDependencyOutputs && (node.dependsOn?.length ?? 0) > 0
                    ? `${node.task}\n\nStructured dependency outcomes (trusted orchestration metadata):\n${JSON.stringify(
                        (node.dependsOn ?? []).map((dependency) => ({
                          id: dependency,
                          output: results.get(dependency)?.output,
                        })),
                      )}`
                    : node.task,
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
                return {
                  id,
                  status: "passed",
                  result: cumulativeResult,
                  output: {
                    status: cumulativeResult.status,
                    ...(cumulativeResult.loopId ? { loopId: cumulativeResult.loopId } : {}),
                    sessionId: cumulativeResult.sessionId,
                    costUsd: cumulativeResult.costUsd,
                    tokensUsed: cumulativeResult.tokensUsed ?? 0,
                    iterations: cumulativeResult.iterations,
                  },
                  attempts: attempt,
                };
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
    persist(!approvalPending);
    return options.nodes.map(
      (node) => results.get(node.id) ?? { id: node.id, status: "skipped", reason: "not scheduled" },
    );
  } finally {
    lease?.release();
  }
}

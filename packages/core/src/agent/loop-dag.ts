import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentCoreDeps } from "./loop.js";
import { runAutoLoop, type LoopOptions, type LoopResult, type LoopStatus } from "./auto-loop.js";
import { predictLoopBudgetWeight, recordLoopBudgetObservation } from "./loop-budget-history.js";
import { acquireSessionLease, acquireSessionLeaseWithPreemption } from "./session-lease.js";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import {
  checkpointWorktree,
  createWorktree,
  listGitWorktrees,
  mergeWorktree,
  removeWorktree,
  worktreeSlug,
} from "../worktree.js";

export type LoopDagFailurePolicy = "skip_dependents" | "continue" | "stop";
export type LoopDagCondition =
  | { nodeId: string; status: "passed" | "failed" }
  | { all: LoopDagCondition[] }
  | { any: LoopDagCondition[] }
  | { not: LoopDagCondition };
export type LoopDagNodeOutput = {
  status: LoopResult["status"];
  loopId?: string;
  sessionId: string;
  costUsd: number;
  tokensUsed: number;
  iterations: number;
  artifacts?: string[];
  /** Exact retained branch created by managedWorktrees; never inferred from user-declared artifacts. */
  managedBranch?: string;
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
  /** Relative regular files that a passing node promises to produce. */
  outputPaths?: string[];
  /** Stable identity for a custom options.verify implementation across durable resumes. */
  verifierId?: string;
  options?: Partial<
    Omit<LoopOptions, "task" | "workspace" | "verifyCommand" | "signal" | "onEvent" | "resumeState" | "loopId">
  >;
};

export type LoopDagNodeResult = {
  id: string;
  status: "passed" | "failed" | "skipped" | "waiting_approval" | "approved";
  result?: LoopResult;
  output?: LoopDagNodeOutput;
  reason?: string;
  attempts?: number;
  approval?: { approvedAt: string; actor?: string; reason?: string };
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
  /** Reweight ready-node shares from bounded historical cost/duration observations. */
  predictiveBudget?: boolean;
  signal?: AbortSignal;
  workspaceForNode?: (node: LoopDagNode) => string;
  /** Create one retained Git worktree per node when explicit workspaces are absent. */
  managedWorktrees?: boolean | { integrateDependencies?: boolean };
  /** Refuse provisioning when managed SeekForge worktrees would exceed this repository-wide count. */
  managedWorktreeLimit?: number;
  /** Merge successful sink branches into an integration worktree and verify the combined tree. */
  fanIn?: { verifyCommand: string; maxIterations?: number };
  onFanIn?: (result: LoopDagFanInResult) => void;
  /** Nodes to invalidate together with every downstream dependent when resuming. */
  rerunFrom?: string[];
  approveNode?: (
    node: LoopDagNode,
    completed: ReadonlyMap<string, LoopDagNodeResult>,
  ) =>
    | boolean
    | { approved: boolean; actor?: string; reason?: string }
    | Promise<boolean | { approved: boolean; actor?: string; reason?: string }>;
  onNodeEvent?: (nodeId: string, event: Parameters<NonNullable<LoopOptions["onEvent"]>>[0]) => void;
};

export type LoopDagFanInResult = {
  status: "passed" | "failed";
  workspace: string;
  branch: string;
  updatedAt: string;
  result?: LoopResult;
  error?: string;
};

type ManagedNodeWorktree = { path: string; branch: string; created: boolean };

export type PersistedLoopDagState = {
  schemaVersion: 1;
  dagId: string;
  fingerprint: string;
  spentCost: number;
  spentTokens: number;
  results: LoopDagNodeResult[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  fanIn?: LoopDagFanInResult;
};

const DAG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MANAGED_BRANCH_RE = /^seekforge\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
          outputPaths: [...(node.outputPaths ?? [])].sort(),
          verifierId: node.verifierId,
          workspace: workspaces.get(node.id),
          options: node.options,
        })),
      ),
    )
    .digest("hex");
}

function parseFanIn(value: unknown): LoopDagFanInResult | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    (value.status !== "passed" && value.status !== "failed") ||
    typeof value.workspace !== "string" ||
    typeof value.branch !== "string" ||
    !value.branch.startsWith("seekforge/") ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8_192))
  ) {
    return null;
  }
  const result = value.result === undefined ? undefined : parseLoopResult(value.result);
  if (value.result !== undefined && result === null) return null;
  return {
    status: value.status,
    workspace: value.workspace,
    branch: value.branch,
    updatedAt: value.updatedAt,
    ...(result ? { result } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function dagStatePath(dagId: string): string {
  if (!DAG_ID_RE.test(dagId)) throw new Error(`Loop DAG id must be safe: ${dagId}`);
  return `.seekforge/loop-dags/${dagId}.json`;
}

function managedWorktreeSlug(seed: string, nodeId: string): string {
  const suffix = createHash("sha256").update(`${seed}:${nodeId}`).digest("hex").slice(0, 10);
  const prefix = worktreeSlug(`dag-${seed}-${nodeId}`).slice(0, 52).replace(/-+$/, "");
  return `${prefix}-${suffix}`;
}

function managedWorktreePath(workspace: string, seed: string, nodeId: string): string {
  return join(realpathSync.native(workspace), ".seekforge", "worktrees", managedWorktreeSlug(seed, nodeId));
}

async function prepareManagedWorktrees(
  workspace: string,
  nodes: readonly LoopDagNode[],
  seed: string,
  resume: boolean,
): Promise<Map<string, ManagedNodeWorktree>> {
  const existing = resume ? await listGitWorktrees(workspace) : [];
  const byBranch = new Map(existing.map((entry) => [entry.branch, entry.path]));
  const result = new Map<string, ManagedNodeWorktree>();
  try {
    for (const node of nodes) {
      const slug = managedWorktreeSlug(seed, node.id);
      const branch = `seekforge/${slug}`;
      const retained = byBranch.get(branch);
      if (retained) {
        const physical = realpathSync.native(retained);
        const expected = managedWorktreePath(workspace, seed, node.id);
        if (physical !== expected) {
          throw new Error(`Managed Loop DAG worktree is outside its expected path for node ${node.id}: ${physical}`);
        }
        result.set(node.id, { path: physical, branch, created: false });
        continue;
      }
      if (resume) throw new Error(`Managed Loop DAG worktree is missing for node ${node.id}: ${branch}`);
      const created = await createWorktree(workspace, slug);
      result.set(node.id, { ...created, path: realpathSync.native(created.path), created: true });
    }
    return result;
  } catch (error) {
    for (const entry of [...result.values()].reverse()) {
      if (entry.created) await removeWorktree(workspace, entry.path, entry.branch).catch(() => undefined);
    }
    throw error;
  }
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

function parseDagState(raw: string, dagId: string, fingerprint?: string): PersistedLoopDagState | null {
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
    typeof value.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
    (fingerprint !== undefined && value.fingerprint !== fingerprint) ||
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
  const fanIn = parseFanIn(value.fanIn);
  if (fanIn === null) return null;
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
        item.status !== "waiting_approval" &&
        item.status !== "approved") ||
      (item.reason !== undefined && (typeof item.reason !== "string" || item.reason.length > 8_192)) ||
      (item.attempts !== undefined && (!Number.isSafeInteger(item.attempts) || (item.attempts as number) <= 0)) ||
      (item.approval !== undefined &&
        (!isRecord(item.approval) ||
          typeof item.approval.approvedAt !== "string" ||
          !Number.isFinite(Date.parse(item.approval.approvedAt)) ||
          (item.approval.actor !== undefined &&
            (typeof item.approval.actor !== "string" || item.approval.actor.length > 256)) ||
          (item.approval.reason !== undefined &&
            (typeof item.approval.reason !== "string" || item.approval.reason.length > 2_048)))) ||
      (item.status === "approved" && item.approval === undefined)
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
      (outputValue.loopId === undefined || typeof outputValue.loopId === "string") &&
      (outputValue.managedBranch === undefined ||
        (typeof outputValue.managedBranch === "string" && MANAGED_BRANCH_RE.test(outputValue.managedBranch))) &&
      (outputValue.artifacts === undefined ||
        (Array.isArray(outputValue.artifacts) &&
          outputValue.artifacts.length <= 64 &&
          outputValue.artifacts.every((item) => typeof item === "string" && isSafeRelativePath(item))))
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
      ...(isRecord(item.approval)
        ? {
            approval: {
              approvedAt: item.approval.approvedAt as string,
              ...(typeof item.approval.actor === "string" ? { actor: item.approval.actor } : {}),
              ...(typeof item.approval.reason === "string" ? { reason: item.approval.reason } : {}),
            },
          }
        : {}),
    });
  }
  return { ...(value as PersistedLoopDagState), results, ...(fanIn ? { fanIn } : {}) };
}

export function loadLoopDagState(workspace: string, dagId: string): PersistedLoopDagState | null {
  if (!DAG_ID_RE.test(dagId)) return null;
  const raw = readWorkspaceStateFile(workspace, dagStatePath(dagId), DAG_STATE_LIMIT);
  return raw === undefined ? null : parseDagState(raw, dagId);
}

export function listLoopDagStates(workspace: string): PersistedLoopDagState[] {
  const root = realpathSync.native(workspace);
  const directory = join(root, ".seekforge", "loop-dags");
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !realpathSync.native(directory).startsWith(`${root}${sep}`)) {
      return [];
    }
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      .slice(0, 256)
      .flatMap((entry) => {
        try {
          const state = loadLoopDagState(workspace, entry.name.slice(0, -5));
          return state ? [state] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function saveDagState(workspace: string, state: PersistedLoopDagState): void {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > DAG_STATE_LIMIT) throw new Error("Loop DAG checkpoint exceeds 1 MiB");
  writeWorkspaceStateFileAtomic(workspace, dagStatePath(state.dagId), serialized);
}

function isSafeRelativePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 512 &&
    !isAbsolute(path) &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    path
      .replaceAll("\\", "/")
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function conditionReferences(condition: LoopDagCondition, refs: string[] = [], depth = 0): string[] | undefined {
  if (depth > 8 || refs.length > 64 || !isRecord(condition)) return undefined;
  if ("nodeId" in condition) {
    if (!DAG_ID_RE.test(condition.nodeId) || (condition.status !== "passed" && condition.status !== "failed")) {
      return undefined;
    }
    refs.push(condition.nodeId);
    return refs.length <= 64 ? refs : undefined;
  }
  if ("not" in condition) return conditionReferences(condition.not, refs, depth + 1);
  const group = "all" in condition ? condition.all : "any" in condition ? condition.any : undefined;
  if (!Array.isArray(group) || group.length === 0 || group.length > 32) return undefined;
  for (const child of group) if (!conditionReferences(child, refs, depth + 1)) return undefined;
  return refs;
}

function conditionMatches(condition: LoopDagCondition, results: ReadonlyMap<string, LoopDagNodeResult>): boolean {
  if ("nodeId" in condition) return results.get(condition.nodeId)?.status === condition.status;
  if ("not" in condition) return !conditionMatches(condition.not, results);
  if ("all" in condition) return condition.all.every((child) => conditionMatches(child, results));
  return condition.any.some((child) => conditionMatches(child, results));
}

function collectArtifacts(workspace: string, paths: readonly string[] | undefined): string[] | undefined {
  if (!paths?.length) return undefined;
  const root = realpathSync.native(workspace);
  const artifacts: string[] = [];
  for (const path of paths) {
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(`${root}${sep}`))
      throw new Error(`Unsafe Loop DAG artifact path: ${path}`);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Loop DAG artifact is not a regular file: ${path}`);
    const actual = realpathSync.native(target);
    if (!actual.startsWith(`${root}${sep}`)) throw new Error(`Loop DAG artifact escapes its workspace: ${path}`);
    artifacts.push(relative(root, actual).replaceAll("\\", "/"));
  }
  return artifacts;
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
  const conditionRefs = node.condition ? conditionReferences(node.condition) : [];
  if (conditionRefs === undefined || conditionRefs.some((id) => !(node.dependsOn ?? []).includes(id))) {
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
  if (
    node.outputPaths !== undefined &&
    (!Array.isArray(node.outputPaths) ||
      node.outputPaths.length === 0 ||
      node.outputPaths.length > 64 ||
      new Set(node.outputPaths).size !== node.outputPaths.length ||
      node.outputPaths.some((path) => !isSafeRelativePath(path)))
  ) {
    throw new Error(`Loop DAG node outputPaths must be unique safe relative paths: ${node.id}`);
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
  if (node.condition && conditionReferences(node.condition)?.includes(dependency)) {
    return result !== undefined && result.status !== "waiting_approval" && result.status !== "approved";
  }
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
  if (options.predictiveBudget !== undefined && typeof options.predictiveBudget !== "boolean") {
    throw new Error("Loop DAG predictiveBudget must be boolean");
  }
  if (concurrency > 1 && !options.workspaceForNode) {
    if (!options.managedWorktrees) {
      throw new Error("Concurrent Loop DAG nodes require workspaceForNode isolation or managedWorktrees");
    }
  }
  if (options.workspaceForNode && options.managedWorktrees) {
    throw new Error("Loop DAG managedWorktrees cannot be combined with workspaceForNode");
  }
  if (
    options.managedWorktrees !== undefined &&
    typeof options.managedWorktrees !== "boolean" &&
    (!isRecord(options.managedWorktrees) ||
      (options.managedWorktrees.integrateDependencies !== undefined &&
        typeof options.managedWorktrees.integrateDependencies !== "boolean"))
  ) {
    throw new Error("Loop DAG managedWorktrees configuration is invalid");
  }
  if (
    options.managedWorktreeLimit !== undefined &&
    (!Number.isSafeInteger(options.managedWorktreeLimit) ||
      options.managedWorktreeLimit < 1 ||
      options.managedWorktreeLimit > 256)
  ) {
    throw new Error("Loop DAG managedWorktreeLimit must be 1 to 256");
  }
  if (options.managedWorktreeLimit !== undefined && !options.managedWorktrees) {
    throw new Error("Loop DAG managedWorktreeLimit requires managedWorktrees");
  }
  if (options.fanIn !== undefined) {
    if (!isRecord(options.fanIn)) throw new Error("Loop DAG fanIn configuration is invalid");
    if (!options.managedWorktrees) throw new Error("Loop DAG fanIn requires managedWorktrees");
    if (
      typeof options.fanIn.verifyCommand !== "string" ||
      !options.fanIn.verifyCommand.trim() ||
      options.fanIn.verifyCommand.length > 8_192
    ) {
      throw new Error("Loop DAG fanIn verifyCommand is invalid");
    }
    if (
      options.fanIn.maxIterations !== undefined &&
      (!Number.isSafeInteger(options.fanIn.maxIterations) ||
        options.fanIn.maxIterations < 1 ||
        options.fanIn.maxIterations > 5)
    ) {
      throw new Error("Loop DAG fanIn maxIterations must be 1 to 5");
    }
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
  const managedSeed =
    options.dagId ??
    createHash("sha256")
      .update(JSON.stringify({ nodes: options.nodes, fanIn: options.fanIn }))
      .digest("hex")
      .slice(0, 16);
  const nodeWorkspaces = new Map(
    options.nodes.map((node) => [
      node.id,
      options.managedWorktrees
        ? managedWorktreePath(options.workspace, managedSeed, node.id)
        : realpathSync.native(options.workspaceForNode?.(node) ?? options.workspace),
    ]),
  );
  if (concurrency > 1 && new Set(nodeWorkspaces.values()).size !== nodeWorkspaces.size) {
    throw new Error("Concurrent Loop DAG nodes must resolve to distinct workspaces");
  }
  const fingerprint = createHash("sha256")
    .update(dagFingerprint(options.nodes, nodeWorkspaces))
    .update(
      JSON.stringify({
        fanIn: options.fanIn,
        managedWorktrees: options.managedWorktrees ?? false,
        managedWorktreeLimit: options.managedWorktreeLimit,
        predictiveBudget: options.predictiveBudget ?? false,
      }),
    )
    .digest("hex");
  const dagId = options.dagId ?? `dag-${fingerprint.slice(0, 16)}`;
  if (!DAG_ID_RE.test(dagId)) throw new Error(`Loop DAG id must be safe: ${dagId}`);
  const lease =
    persistenceEnabled || options.managedWorktrees
      ? await acquireSessionLeaseWithPreemption(options.workspace, `loop-dag-${dagId}`, {
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : undefined;
  let managedResourceLease: ReturnType<typeof acquireSessionLease> | undefined;
  try {
    if (options.managedWorktrees) {
      managedResourceLease = acquireSessionLease(options.workspace, "loop-dag-managed-worktrees");
    }
    if (options.managedWorktrees && options.managedWorktreeLimit !== undefined) {
      const existing = await listGitWorktrees(options.workspace);
      const branches = new Set(existing.map((entry) => entry.branch));
      const required = [
        ...options.nodes.map((node) => `seekforge/${managedWorktreeSlug(managedSeed, node.id)}`),
        ...(options.fanIn ? [`seekforge/${managedWorktreeSlug(managedSeed, "integration")}`] : []),
      ];
      const managedCount = existing.filter((entry) => entry.branch.startsWith("seekforge/")).length;
      const missing = required.filter((branch) => !branches.has(branch)).length;
      if (managedCount + missing > options.managedWorktreeLimit) {
        throw new Error(
          `Loop DAG managed worktree limit would be exceeded: ${managedCount} existing + ${missing} required > ${options.managedWorktreeLimit}`,
        );
      }
    }
    const managedWorktrees = options.managedWorktrees
      ? await prepareManagedWorktrees(options.workspace, options.nodes, managedSeed, options.resume === true)
      : undefined;
    const integrateDependencies =
      typeof options.managedWorktrees !== "object" || options.managedWorktrees.integrateDependencies !== false;
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
      if (checkpoint.fanIn && options.managedWorktrees) {
        const slug = managedWorktreeSlug(managedSeed, "integration");
        const branch = `seekforge/${slug}`;
        const retained = (await listGitWorktrees(options.workspace)).find((entry) => entry.branch === branch);
        if (!retained || checkpoint.fanIn.branch !== branch) {
          throw new Error(`Managed Loop DAG integration worktree is missing: ${branch}`);
        }
        const physical = realpathSync.native(retained.path);
        if (physical !== managedWorktreePath(options.workspace, managedSeed, "integration")) {
          throw new Error(`Managed Loop DAG integration worktree is outside its expected path: ${physical}`);
        }
      }
    }
    const results = new Map(checkpoint.results.map((result) => [result.id, result]));
    const approvals = new Map<string, NonNullable<LoopDagNodeResult["approval"]>>();
    for (const id of results.keys()) {
      if (!byId.has(id)) throw new Error(`Persisted Loop DAG contains an unknown node: ${id}`);
    }
    for (const [id, result] of results) {
      if (result.status === "approved" && result.approval) approvals.set(id, result.approval);
      if (result.status === "waiting_approval" || result.status === "approved") results.delete(id);
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
      for (const id of invalidated) {
        results.delete(id);
        approvals.delete(id);
      }
      checkpoint = { ...checkpoint, fanIn: undefined, completedAt: undefined };
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
          const result =
            results.get(node.id) ??
            (approvals.has(node.id)
              ? { id: node.id, status: "approved" as const, approval: approvals.get(node.id)! }
              : undefined);
          return result ? [result] : [];
        }),
        updatedAt: new Date().toISOString(),
        completedAt: completed ? new Date().toISOString() : undefined,
      };
      saveDagState(options.workspace, checkpoint);
    };
    persist(false);

    const executeNode = async (
      id: string,
      remainingCost: number | undefined,
      remainingTokens: number | undefined,
      approval: LoopDagNodeResult["approval"],
    ): Promise<LoopDagNodeResult> => {
      const node = byId.get(id)!;
      const workspace = nodeWorkspaces.get(id)!;
      const remainingDuration =
        options.maxDurationMs === undefined ? undefined : options.maxDurationMs - (Date.now() - startedAt);
      if (
        (remainingCost !== undefined && remainingCost <= 0) ||
        (remainingTokens !== undefined && remainingTokens <= 0) ||
        (remainingDuration !== undefined && remainingDuration <= 0)
      ) {
        return {
          id,
          status: "skipped",
          reason: "shared DAG budget exhausted",
          attempts: 1,
          ...(approval ? { approval } : {}),
        };
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
          if (managedWorktrees && options.managedWorktrees !== false) {
            if (integrateDependencies) {
              for (const dependency of node.dependsOn ?? []) {
                if (results.get(dependency)?.status !== "passed") continue;
                const source = managedWorktrees.get(dependency);
                if (!source) continue;
                const merged = await mergeWorktree(workspace, source.path, source.branch);
                if ("conflict" in merged) {
                  throw new Error(
                    `dependency integration conflict from ${dependency}: ${merged.files.slice(0, 32).join(", ")}`,
                  );
                }
              }
            }
          }
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
            workspace,
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
            const managed = managedWorktrees?.get(id);
            if (managed) await checkpointWorktree(workspace, `chore: checkpoint Loop DAG node ${id}`);
            const artifacts = [
              ...(collectArtifacts(workspace, node.outputPaths) ?? []),
              ...(managed ? [managed.branch] : []),
            ];
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
                ...(artifacts.length > 0 ? { artifacts } : {}),
                ...(managed ? { managedBranch: managed.branch } : {}),
              },
              attempts: attempt,
              ...(approval ? { approval } : {}),
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
        ...(approval ? { approval } : {}),
      };
    };

    let stopRequested = false;
    let approvalPending = false;
    const running = new Map<
      string,
      {
        promise: Promise<LoopDagNodeResult>;
        workspace: string;
        resources: string[];
        reservedCost: number;
        reservedTokens: number;
      }
    >();
    while ((pending.size > 0 || running.size > 0) && (!stopRequested || running.size > 0)) {
      options.signal?.throwIfAborted();
      if (!stopRequested)
        for (const id of [...pending]) {
          const node = byId.get(id)!;
          if (node.condition) {
            const conditionRefs = conditionReferences(node.condition) ?? [];
            const conditionResolved = conditionRefs.every((dependency) => {
              const result = results.get(dependency);
              return result?.status === "passed" || result?.status === "failed" || result?.status === "skipped";
            });
            if (conditionResolved && !conditionMatches(node.condition, results)) {
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
      const candidates = stopRequested
        ? []
        : [...pending]
            .filter((id) =>
              (byId.get(id)?.dependsOn ?? []).every((dependency) => {
                const node = byId.get(id)!;
                return dependencyAllowsNode(node, dependency, byId.get(dependency), results.get(dependency));
              }),
            )
            .sort((left, right) => (byId.get(right)?.priority ?? 0) - (byId.get(left)?.priority ?? 0));
      const ready: string[] = [];
      const reservedResources = new Set([...running.values()].flatMap((entry) => entry.resources));
      const reservedWorkspaces = new Set([...running.values()].map((entry) => entry.workspace));
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
        if (ready.length + running.size === concurrency) break;
      }
      if (ready.length === 0 && running.size === 0) {
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
        if (!node.requiresApproval || approvals.has(id)) continue;
        const decision = await options.approveNode?.(node, results);
        const approved = decision === true || (isRecord(decision) && decision.approved === true);
        if (approved) {
          const approvedAt = new Date().toISOString();
          approvals.set(id, {
            approvedAt,
            ...(isRecord(decision) && typeof decision.actor === "string"
              ? { actor: decision.actor.slice(0, 256) }
              : {}),
            ...(isRecord(decision) && typeof decision.reason === "string"
              ? { reason: decision.reason.slice(0, 2_048) }
              : {}),
          });
          // Approval authorizes the side effect and must be durable before the
          // node can start. A resume reuses this exact approval instead of
          // prompting again or silently widening it.
          persist(false);
          continue;
        }
        results.set(id, { id, status: "waiting_approval", reason: "explicit approval required" });
        pending.delete(id);
        ready.splice(ready.indexOf(id), 1);
        approvalPending = true;
      }
      if (ready.length === 0 && approvalPending) {
        if (running.size === 0) {
          persist(false);
          continue;
        }
      }
      const schedulingWeight = (id: string): number => {
        const node = byId.get(id)!;
        if (!options.predictiveBudget) return node.budgetWeight ?? 1;
        const key = `${node.id}:${createHash("sha256").update(node.verifyCommand).digest("hex").slice(0, 16)}`;
        return predictLoopBudgetWeight(options.workspace, key, node.budgetWeight ?? 1).weight;
      };
      const totalWeight = ready.reduce((sum, id) => sum + schedulingWeight(id), 0);
      const alreadyReservedCost = [...running.values()].reduce((sum, entry) => sum + entry.reservedCost, 0);
      const alreadyReservedTokens = [...running.values()].reduce((sum, entry) => sum + entry.reservedTokens, 0);
      for (const id of ready) {
        const node = byId.get(id)!;
        const approval = approvals.get(id);
        const weightShare = totalWeight > 0 ? schedulingWeight(id) / totalWeight : 0;
        const remainingCost =
          options.costBudgetUsd === undefined
            ? undefined
            : Math.max(0, options.costBudgetUsd - spentCost - alreadyReservedCost) * weightShare;
        const remainingTokens =
          options.tokenBudget === undefined
            ? undefined
            : Math.floor(Math.max(0, options.tokenBudget - spentTokens - alreadyReservedTokens) * weightShare);
        pending.delete(id);
        running.set(id, {
          promise: executeNode(id, remainingCost, remainingTokens, approval),
          workspace: nodeWorkspaces.get(id)!,
          resources: [...(node.resources ?? [])],
          reservedCost: remainingCost ?? 0,
          reservedTokens: remainingTokens ?? 0,
        });
      }
      if (running.size === 0) continue;
      const settled = await Promise.race(
        [...running].map(([id, entry]) => entry.promise.then((result) => ({ id, result }))),
      );
      running.delete(settled.id);
      approvals.delete(settled.id);
      results.set(settled.id, settled.result);
      spentCost += settled.result.result?.costUsd ?? 0;
      spentTokens += settled.result.result?.tokensUsed ?? 0;
      if (options.predictiveBudget && settled.result.result) {
        const node = byId.get(settled.id)!;
        try {
          recordLoopBudgetObservation(options.workspace, {
            key: `${node.id}:${createHash("sha256").update(node.verifyCommand).digest("hex").slice(0, 16)}`,
            costUsd: settled.result.result.costUsd,
            tokens: settled.result.result.tokensUsed ?? 0,
            durationMs: settled.result.result.elapsedMs ?? 0,
            passed: settled.result.status === "passed",
            recordedAt: new Date().toISOString(),
          });
        } catch {
          /* advisory scheduling history only */
        }
      }
      if (settled.result.status === "failed" && byId.get(settled.id)?.failurePolicy === "stop") {
        stopRequested = true;
      }
      persist(false);
    }
    if (stopRequested) {
      for (const id of pending) results.set(id, { id, status: "skipped", reason: "DAG stopped after node failure" });
      pending.clear();
    }
    const orderedResults: LoopDagNodeResult[] = options.nodes.map(
      (node) => results.get(node.id) ?? { id: node.id, status: "skipped", reason: "not scheduled" },
    );
    let fanInPassed = options.fanIn === undefined || checkpoint.fanIn?.status === "passed";
    if (
      options.fanIn &&
      !fanInPassed &&
      !approvalPending &&
      orderedResults.every((result) => result.status === "passed")
    ) {
      const slug = managedWorktreeSlug(managedSeed, "integration");
      const branch = `seekforge/${slug}`;
      const retained = (await listGitWorktrees(options.workspace)).find((entry) => entry.branch === branch);
      const expectedIntegrationPath = managedWorktreePath(options.workspace, managedSeed, "integration");
      const integration = retained
        ? { path: realpathSync.native(retained.path), branch }
        : await createWorktree(options.workspace, slug).then((created) => ({
            ...created,
            path: realpathSync.native(created.path),
          }));
      if (integration.path !== expectedIntegrationPath) {
        throw new Error(`Managed Loop DAG integration worktree is outside its expected path: ${integration.path}`);
      }
      let fanIn: LoopDagFanInResult;
      let fanInLoopResult: LoopResult | undefined;
      try {
        if (retained) {
          await checkpointWorktree(integration.path, "chore: checkpoint prior Loop DAG integration attempt");
        }
        const dependedOn = new Set(options.nodes.flatMap((node) => node.dependsOn ?? []));
        const sources = integrateDependencies
          ? options.nodes.filter((node) => !dependedOn.has(node.id))
          : options.nodes;
        for (const node of sources) {
          const source = managedWorktrees?.get(node.id);
          if (!source) continue;
          const merged = await mergeWorktree(integration.path, source.path, source.branch);
          if ("conflict" in merged) {
            throw new Error(`fan-in conflict from ${node.id}: ${merged.files.slice(0, 32).join(", ")}`);
          }
        }
        const remainingCost =
          options.costBudgetUsd === undefined ? undefined : Math.max(0, options.costBudgetUsd - spentCost);
        const remainingTokens =
          options.tokenBudget === undefined ? undefined : Math.max(0, options.tokenBudget - spentTokens);
        const remainingDuration =
          options.maxDurationMs === undefined ? undefined : options.maxDurationMs - (Date.now() - startedAt);
        if (
          (remainingCost !== undefined && remainingCost <= 0) ||
          (remainingTokens !== undefined && remainingTokens <= 0) ||
          (remainingDuration !== undefined && remainingDuration <= 0)
        ) {
          throw new Error("shared DAG budget exhausted before fan-in verification");
        }
        fanInLoopResult = await runAutoLoop(deps, {
          task: "Verify and, if necessary, repair the combined Loop DAG integration without weakening its gate.",
          workspace: integration.path,
          verifyCommand: options.fanIn.verifyCommand,
          maxIterations: options.fanIn.maxIterations ?? 1,
          maxNoProgressRecoveries: 0,
          approvalMode: "acceptEdits",
          persist: false,
          ...(remainingCost !== undefined && remainingCost > 0 ? { costBudgetUsd: remainingCost } : {}),
          ...(remainingTokens !== undefined && remainingTokens > 0 ? { tokenBudget: remainingTokens } : {}),
          ...(remainingDuration !== undefined ? { maxDurationMs: Math.floor(remainingDuration) } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        spentCost += fanInLoopResult.costUsd;
        spentTokens += fanInLoopResult.tokensUsed ?? 0;
        if (fanInLoopResult.status !== "passed") {
          throw new Error(`fan-in verification ended with ${fanInLoopResult.status}`);
        }
        await checkpointWorktree(integration.path, "chore: checkpoint Loop DAG integration");
        fanIn = {
          status: "passed",
          workspace: integration.path,
          branch: integration.branch,
          updatedAt: new Date().toISOString(),
          result: fanInLoopResult,
        };
        fanInPassed = true;
      } catch (error) {
        fanIn = {
          status: "failed",
          workspace: integration.path,
          branch: integration.branch,
          updatedAt: new Date().toISOString(),
          ...(fanInLoopResult ? { result: fanInLoopResult } : {}),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 8_192),
        };
      }
      checkpoint = { ...checkpoint, fanIn };
      try {
        options.onFanIn?.(fanIn);
      } catch {
        /* observability only */
      }
    }
    persist(!approvalPending && fanInPassed);
    return orderedResults;
  } finally {
    managedResourceLease?.release();
    lease?.release();
  }
}

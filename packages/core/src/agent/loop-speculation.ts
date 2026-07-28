import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { listGitWorktrees, mergeWorktree } from "../worktree.js";
import type { AgentCoreDeps } from "./loop.js";
import { runLoopDag, type LoopDagOptions, type LoopDagNodeResult } from "./loop-dag.js";
import type { LoopOptions } from "./auto-loop.js";
import { acquireSessionLease } from "./session-lease.js";

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
  speculationId?: string;
  persist?: boolean;
  resume?: boolean;
  verifierId?: string;
};

export type LoopSpeculationResult = {
  candidates: LoopDagNodeResult[];
  /** Lowest-cost passing candidate; publishing or merging remains a separate explicit operation. */
  winner?: LoopDagNodeResult;
  state?: LoopSpeculationState;
};

export type LoopSpeculationState = {
  schemaVersion: 1;
  speculationId: string;
  fingerprint: string;
  status: "running" | "completed" | "failed" | "promoted";
  createdAt: string;
  updatedAt: string;
  candidates: Array<{
    id: string;
    status: LoopDagNodeResult["status"];
    costUsd: number;
    iterations: number;
    branch?: string;
  }>;
  winnerId?: string;
  error?: string;
  promotedAt?: string;
};

const SPECULATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/;
const CANDIDATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MANAGED_BRANCH_RE = /^seekforge\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_BYTES = 256 * 1024;
const statePath = (id: string): string => `.seekforge/loop-speculations/${id}.json`;

function saveState(workspace: string, state: LoopSpeculationState): void {
  writeWorkspaceStateFileAtomic(workspace, statePath(state.speculationId), `${JSON.stringify(state, null, 2)}\n`);
}

export function loadLoopSpeculationState(workspace: string, speculationId: string): LoopSpeculationState | null {
  if (!SPECULATION_ID_RE.test(speculationId)) return null;
  const raw = readWorkspaceStateFile(workspace, statePath(speculationId), STATE_BYTES);
  if (raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.speculationId !== speculationId ||
    typeof value.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint) ||
    (value.status !== "running" &&
      value.status !== "completed" &&
      value.status !== "failed" &&
      value.status !== "promoted") ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 3
  ) {
    return null;
  }
  const candidates: LoopSpeculationState["candidates"] = [];
  const candidateIds = new Set<string>();
  for (const item of value.candidates) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !CANDIDATE_ID_RE.test(item.id) ||
      candidateIds.has(item.id) ||
      (item.status !== "passed" &&
        item.status !== "failed" &&
        item.status !== "skipped" &&
        item.status !== "waiting_approval" &&
        item.status !== "approved") ||
      typeof item.costUsd !== "number" ||
      !Number.isFinite(item.costUsd) ||
      item.costUsd < 0 ||
      !Number.isSafeInteger(item.iterations) ||
      (item.iterations as number) < 0 ||
      (item.branch !== undefined && (typeof item.branch !== "string" || !MANAGED_BRANCH_RE.test(item.branch)))
    )
      return null;
    candidateIds.add(item.id);
    candidates.push(item as LoopSpeculationState["candidates"][number]);
  }
  const createdMs = Date.parse(value.createdAt);
  const updatedMs = Date.parse(value.updatedAt);
  const winner = typeof value.winnerId === "string" ? candidates.find((item) => item.id === value.winnerId) : undefined;
  if (
    updatedMs < createdMs ||
    ((value.status === "completed" || value.status === "promoted") && candidates.length < 2) ||
    (value.winnerId !== undefined && winner?.status !== "passed") ||
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8_192)) ||
    (value.promotedAt !== undefined &&
      (typeof value.promotedAt !== "string" || !Number.isFinite(Date.parse(value.promotedAt)))) ||
    (value.status === "promoted" &&
      (value.promotedAt === undefined ||
        !winner?.branch ||
        Date.parse(value.promotedAt as string) < createdMs ||
        Date.parse(value.promotedAt as string) > updatedMs))
  ) {
    return null;
  }
  return { ...(value as LoopSpeculationState), candidates };
}

export function listLoopSpeculationStates(workspace: string): LoopSpeculationState[] {
  const root = realpathSync.native(workspace);
  const directory = join(root, ".seekforge", "loop-speculations");
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !realpathSync.native(directory).startsWith(`${root}${sep}`)) {
      return [];
    }
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      .slice(0, 256)
      .flatMap((entry) => {
        const state = loadLoopSpeculationState(workspace, entry.name.slice(0, -5));
        return state ? [state] : [];
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function managedSpeculationWorktree(workspace: string, path: string, branch: string): string {
  const root = realpathSync.native(join(realpathSync.native(workspace), ".seekforge", "worktrees"));
  const physical = realpathSync.native(path);
  if (!physical.startsWith(`${root}${sep}`)) {
    throw new Error(`Loop speculation worktree escapes the managed root: ${branch}`);
  }
  return physical;
}

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
    if (!CANDIDATE_ID_RE.test(candidate.id) || ids.has(candidate.id)) {
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
  const persist = options.persist ?? options.speculationId !== undefined;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({ task: options.task, verifyCommand: options.verifyCommand, candidates: options.candidates }),
    )
    .digest("hex");
  const speculationId = options.speculationId ?? `spec-${fingerprint.slice(0, 16)}`;
  if (!SPECULATION_ID_RE.test(speculationId)) throw new Error(`Loop speculation id must be safe: ${speculationId}`);
  const lease = persist ? acquireSessionLease(options.workspace, `loop-speculation-${speculationId}`) : undefined;
  try {
    const existing = persist ? loadLoopSpeculationState(options.workspace, speculationId) : null;
    if (persist && existing && !options.resume) {
      throw new Error(`Persisted Loop speculation already exists; resume it explicitly: ${speculationId}`);
    }
    if (options.resume && (!existing || existing.fingerprint !== fingerprint)) {
      throw new Error(`Persisted Loop speculation is missing or does not match: ${speculationId}`);
    }
    if (options.resume && existing?.status === "promoted") {
      throw new Error(`Promoted Loop speculation cannot be resumed: ${speculationId}`);
    }
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    if (persist && !options.resume) {
      saveState(options.workspace, {
        schemaVersion: 1,
        speculationId,
        fingerprint,
        status: "running",
        createdAt,
        updatedAt: createdAt,
        candidates: [],
      });
    }
    const byId = new Map(options.candidates.map((candidate) => [candidate.id, candidate]));
    let results: LoopDagNodeResult[];
    try {
      results = await runLoopDag(deps, {
        workspace: options.workspace,
        persist,
        ...(persist ? { dagId: `spec-${speculationId}` } : {}),
        ...(options.resume ? { resume: true } : {}),
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
          ...(options.verifierId ? { verifierId: `${options.verifierId}-${candidate.id}`.slice(0, 64) } : {}),
          options: {
            ...options.loopOptions,
            maxIterations: options.maxIterations ?? 2,
            maxNoProgressRecoveries: 0,
          },
        })),
      });
    } catch (error) {
      if (persist) {
        saveState(options.workspace, {
          schemaVersion: 1,
          speculationId,
          fingerprint,
          status: "failed",
          createdAt,
          updatedAt: new Date().toISOString(),
          candidates: existing?.candidates ?? [],
          error: (error instanceof Error ? error.message : String(error)).slice(0, 8_192),
        });
      }
      throw error;
    }
    const winner = results
      .filter((result) => result.status === "passed" && result.result)
      .sort(
        (left, right) =>
          (left.result?.costUsd ?? Number.POSITIVE_INFINITY) - (right.result?.costUsd ?? Number.POSITIVE_INFINITY) ||
          (left.result?.iterations ?? Number.POSITIVE_INFINITY) -
            (right.result?.iterations ?? Number.POSITIVE_INFINITY),
      )[0];
    const state: LoopSpeculationState | undefined = persist
      ? {
          schemaVersion: 1,
          speculationId,
          fingerprint,
          status: "completed",
          createdAt,
          updatedAt: new Date().toISOString(),
          candidates: results.map((result) => ({
            id: result.id,
            status: result.status,
            costUsd: result.result?.costUsd ?? 0,
            iterations: result.result?.iterations ?? 0,
            ...(result.output?.managedBranch ? { branch: result.output.managedBranch } : {}),
          })),
          ...(winner ? { winnerId: winner.id } : {}),
        }
      : undefined;
    if (state) saveState(options.workspace, state);
    return { candidates: results, ...(winner ? { winner } : {}), ...(state ? { state } : {}) };
  } finally {
    lease?.release();
  }
}

export async function promoteLoopSpeculation(workspace: string, speculationId: string): Promise<LoopSpeculationState> {
  const lease = acquireSessionLease(workspace, `loop-speculation-${speculationId}`);
  let resourceLease: ReturnType<typeof acquireSessionLease> | undefined;
  try {
    const state = loadLoopSpeculationState(workspace, speculationId);
    if (!state || (state.status !== "completed" && state.status !== "promoted") || !state.winnerId) {
      throw new Error(`Loop speculation has no promotable winner: ${speculationId}`);
    }
    if (state.status === "promoted") return state;
    resourceLease = acquireSessionLease(workspace, "loop-dag-managed-worktrees");
    const winner = state.candidates.find((item) => item.id === state.winnerId);
    if (!winner?.branch || winner.status !== "passed")
      throw new Error(`Loop speculation winner is invalid: ${state.winnerId}`);
    const entry = (await listGitWorktrees(workspace)).find((item) => item.branch === winner.branch);
    if (!entry) throw new Error(`Loop speculation winner worktree is missing: ${winner.branch}`);
    const physical = managedSpeculationWorktree(workspace, entry.path, entry.branch);
    const merged = await mergeWorktree(workspace, physical, entry.branch);
    if ("conflict" in merged)
      throw new Error(`Loop speculation promotion conflict: ${merged.files.slice(0, 32).join(", ")}`);
    const promoted: LoopSpeculationState = {
      ...state,
      status: "promoted",
      promotedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveState(workspace, promoted);
    return promoted;
  } finally {
    resourceLease?.release();
    lease.release();
  }
}

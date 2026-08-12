/**
 * Loop speculation: two or three isolated candidate repair strategies run
 * concurrently under one shared, mandatory cost budget, and the cheapest
 * passing candidate wins. Promotion stays a separate explicit step.
 *
 * The candidates run as a fan-out of Engineering Graph `loop` nodes with no
 * dependencies between them, so the Graph launches them in one wave and each
 * reserves an equal weighted share of the one shared budget. Speculation was
 * the last non-DAG caller of the retired Loop DAG engine; nothing here imports
 * it any more.
 *
 * The persisted `.seekforge/loop-speculations/` document is unchanged: same
 * schema version, same fields, same identity and fingerprint derivation, so a
 * speculation written by the Loop DAG engine still lists and still promotes.
 * Reading it therefore stays lenient about the one candidate status only the
 * old engine could produce, while a fresh run is validated strictly.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { AgentCoreDeps } from "./loop.js";
import {
  type EngineeringGraphDefinition,
  type GraphLoopOptions,
  parseEngineeringGraphDefinition,
  parseGraphLoopOptions,
} from "./graph-contract.js";
import { runEngineeringGraph } from "./graph-engineering.js";
import type { GraphLoopVerifier } from "./graph-execution-contract.js";
import type { GraphNodeResult } from "./graph-state.js";
import { MANAGED_LOOP_BRANCH_RE, promoteManagedLoopWorktree } from "./loop-managed-worktree.js";
import { acquireSessionLease } from "./session-lease.js";

export type LoopSpeculationCandidate = { id: string; guidance: string };

/**
 * Bounded Loop configuration every candidate receives. The shared cost, token,
 * and duration budgets belong to the speculation rather than to a candidate,
 * so they are not declarable here; `verify` is the injectable verifier the
 * Graph binds through `verifierId`.
 */
export type LoopSpeculationLoopOptions = Omit<GraphLoopOptions, "costBudgetUsd" | "tokenBudget" | "maxDurationMs"> & {
  verify?: GraphLoopVerifier;
};

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
  /** Create and retain one managed Git worktree per candidate. Requires persistence. */
  managedWorktrees?: boolean;
  workspaceForCandidate?: (candidate: LoopSpeculationCandidate) => string;
  loopOptions?: LoopSpeculationLoopOptions;
  signal?: AbortSignal;
  speculationId?: string;
  persist?: boolean;
  resume?: boolean;
  verifierId?: string;
};

export type LoopSpeculationCandidateStatus = "passed" | "failed" | "skipped";

export type LoopSpeculationCandidateResult = {
  id: string;
  status: LoopSpeculationCandidateStatus;
  costUsd: number;
  tokensUsed: number;
  iterations: number;
  attempts: number;
  sessionId?: string;
  /** Retained managed branch; never inferred from user-declared artifacts. */
  branch?: string;
  error?: string;
};

export type LoopSpeculationResult = {
  candidates: LoopSpeculationCandidateResult[];
  /** Lowest-cost passing candidate; publishing or merging remains a separate explicit operation. */
  winner?: LoopSpeculationCandidateResult;
  state?: LoopSpeculationState;
};

/**
 * `approved` is only reachable in a document the retired Loop DAG engine wrote.
 * It is accepted when reading so those speculations keep listing and promoting,
 * and is never produced by a fresh run.
 */
export type PersistedLoopSpeculationCandidateStatus = LoopSpeculationCandidateStatus | "waiting_approval" | "approved";

export type LoopSpeculationState = {
  schemaVersion: 1;
  speculationId: string;
  fingerprint: string;
  status: "running" | "completed" | "failed" | "promoted";
  createdAt: string;
  updatedAt: string;
  candidates: Array<{
    id: string;
    status: PersistedLoopSpeculationCandidateStatus;
    costUsd: number;
    iterations: number;
    branch?: string;
  }>;
  winnerId?: string;
  error?: string;
  promotedAt?: string;
};

const SPECULATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/;
/** Same shape as a Graph node id, which every candidate becomes. */
const CANDIDATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STATE_BYTES = 256 * 1024;
/** Every candidate shares one injectable verifier, so one registered id is enough. */
const DEFAULT_SPECULATION_VERIFIER_ID = "loop-speculation-verifier";
const statePath = (id: string): string => `.seekforge/loop-speculations/${id}.json`;
const legacyDagStatePath = (id: string): string => `.seekforge/loop-dags/spec-${id}.json`;

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
      (item.branch !== undefined && (typeof item.branch !== "string" || !MANAGED_LOOP_BRANCH_RE.test(item.branch)))
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
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** A candidate is a plain Loop node, so only these three statuses are reachable. */
function candidateStatus(status: GraphNodeResult["status"]): LoopSpeculationCandidateStatus {
  return status === "passed" || status === "skipped" ? status : "failed";
}

function candidateIterations(output: unknown): number {
  if (!isRecord(output)) return 0;
  const iterations = output.iterations;
  return Number.isSafeInteger(iterations) && (iterations as number) >= 0 ? (iterations as number) : 0;
}

/**
 * The pure Graph definition a speculation runs. Exported so the fan-out shape —
 * one shared budget, equal weights, one wave — can be asserted without a run.
 * Candidate workspaces arrive already resolved: the physical identity is part
 * of the Graph fingerprint, so it must be settled before the definition exists.
 */
export function loopSpeculationGraphDefinition(
  options: LoopSpeculationOptions,
  input: {
    graphId: string;
    loopOptions: GraphLoopOptions;
    verifierIdForCandidate?: (id: string) => string;
    workspaces?: ReadonlyMap<string, string>;
  },
): EngineeringGraphDefinition {
  return {
    graphId: input.graphId,
    // Candidates are independent alternatives: they never depend on each other,
    // never integrate each other's worktrees, and one failing must not end the run.
    failurePolicy: "continue",
    maxConcurrency: options.candidates.length,
    costBudgetUsd: options.costBudgetUsd,
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
    ...(options.managedWorktrees ? { managedWorktrees: { integrateDependencies: false, limit: 256 } } : {}),
    nodes: options.candidates.map((candidate) => ({
      id: candidate.id,
      kind: "loop" as const,
      task: `${options.task}\n\nCandidate strategy ${candidate.id}: ${candidate.guidance}`,
      verifyCommand: options.verifyCommand,
      failurePolicy: "continue" as const,
      ...(input.workspaces?.has(candidate.id) ? { workspace: input.workspaces.get(candidate.id)! } : {}),
      ...(input.verifierIdForCandidate ? { verifierId: input.verifierIdForCandidate(candidate.id) } : {}),
      loopOptions: input.loopOptions,
    })),
  };
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
  if (options.managedWorktrees && options.workspaceForCandidate) {
    throw new Error("Loop speculation managedWorktrees cannot be combined with workspaceForCandidate");
  }
  const persist = options.persist ?? options.speculationId !== undefined;
  // Managed worktrees only mean something with a checkpoint that can find them
  // again, and promotion reads that checkpoint. Say so here rather than letting
  // the Graph refuse the same combination in its own vocabulary.
  if (options.managedWorktrees && !persist) {
    throw new Error("Loop speculation managedWorktrees require persistence");
  }
  const { verify, ...declaredLoopOptions } = options.loopOptions ?? {};
  // One owner validates the declarable Loop configuration, before any lease,
  // worktree, or checkpoint exists. An option the Graph cannot carry is named
  // rather than dropped on the way to the child Loop.
  const loopOptions = parseGraphLoopOptions(
    {
      ...declaredLoopOptions,
      maxIterations: options.maxIterations ?? 2,
      maxNoProgressRecoveries: 0,
    },
    "Loop speculation Loop options",
  );
  if (options.verifierId !== undefined && !CANDIDATE_ID_RE.test(options.verifierId)) {
    throw new Error(`Loop speculation verifierId must be safe: ${options.verifierId}`);
  }
  if (options.verifierId !== undefined && !verify) {
    throw new Error("Loop speculation verifierId requires loopOptions.verify");
  }
  if (verify && persist && options.verifierId === undefined) {
    throw new Error("Persisted Loop speculation with a custom verifier requires verifierId");
  }
  const verifierIdForCandidate = (candidateId: string): string =>
    options.verifierId === undefined
      ? DEFAULT_SPECULATION_VERIFIER_ID
      : `${options.verifierId}-${candidateId}`.slice(0, 64);
  const verifiers: Record<string, GraphLoopVerifier> = Object.create(null) as Record<string, GraphLoopVerifier>;
  if (verify) {
    for (const candidate of options.candidates) {
      const id = verifierIdForCandidate(candidate.id);
      if (!CANDIDATE_ID_RE.test(id)) throw new Error(`Loop speculation verifier id is invalid: ${id}`);
      verifiers[id] = verify;
    }
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({ task: options.task, verifyCommand: options.verifyCommand, candidates: options.candidates }),
    )
    .digest("hex");
  const speculationId = options.speculationId ?? `spec-${fingerprint.slice(0, 16)}`;
  if (!SPECULATION_ID_RE.test(speculationId)) throw new Error(`Loop speculation id must be safe: ${speculationId}`);
  // Resolved exactly like the workspace the Graph itself resolves, so a
  // symlinked temporary root does not read as an escape from the run root.
  const workspaces = options.workspaceForCandidate
    ? new Map(
        options.candidates.map((candidate) => [
          candidate.id,
          realpathSync.native(options.workspaceForCandidate!(candidate)),
        ]),
      )
    : undefined;
  // The Graph contract is the owner of every remaining bound (id shape, budget
  // ranges, node limits). Running it here keeps the whole validation pure and
  // ahead of the lease and the first checkpoint.
  const definition = parseEngineeringGraphDefinition(
    loopSpeculationGraphDefinition(options, {
      graphId: `spec-${speculationId}`,
      loopOptions,
      ...(verify ? { verifierIdForCandidate } : {}),
      ...(workspaces ? { workspaces } : {}),
    }),
  );
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
    if (
      options.resume &&
      readWorkspaceStateFile(options.workspace, legacyDagStatePath(speculationId), STATE_BYTES) !== undefined
    ) {
      // The Loop DAG checkpoint of a speculation started on the retired engine
      // cannot be continued by the Graph: its managed worktrees are bound to
      // different branches. Say so instead of failing as a missing Graph.
      throw new Error(
        `Loop speculation ${speculationId} was started on the retired Loop DAG engine and cannot be resumed; promote its winner or start a new speculation id`,
      );
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
    let results: LoopSpeculationCandidateResult[];
    try {
      const graph = await runEngineeringGraph(deps, definition, {
        workspace: options.workspace,
        persist,
        ...(options.resume ? { resume: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(verify ? { verifiers } : {}),
      });
      // The Graph reports cancellation as a state; the speculation contract is
      // that an aborted run rejects and leaves a failed checkpoint behind.
      options.signal?.throwIfAborted();
      if (graph.status !== "passed" && graph.status !== "failed") {
        throw new Error(`Loop speculation did not finish: ${graph.status}`);
      }
      const byNode = new Map(graph.results.map((result) => [result.id, result]));
      results = options.candidates.map((candidate) => {
        const result = byNode.get(candidate.id);
        if (!result) {
          return {
            id: candidate.id,
            status: "skipped",
            costUsd: 0,
            tokensUsed: 0,
            iterations: 0,
            attempts: 0,
            error: "not scheduled",
          };
        }
        return {
          id: candidate.id,
          status: candidateStatus(result.status),
          costUsd: result.costUsd,
          tokensUsed: result.tokensUsed,
          iterations: candidateIterations(result.output),
          attempts: result.attempts,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.managedBranch ? { branch: result.managedBranch } : {}),
          ...(result.error ? { error: result.error.slice(0, 8_192) } : {}),
        };
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
      .filter((result) => result.status === "passed")
      .sort((left, right) => left.costUsd - right.costUsd || left.iterations - right.iterations)[0];
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
            costUsd: result.costUsd,
            iterations: result.iterations,
            ...(result.branch ? { branch: result.branch } : {}),
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
  try {
    const state = loadLoopSpeculationState(workspace, speculationId);
    if (!state || (state.status !== "completed" && state.status !== "promoted") || !state.winnerId) {
      throw new Error(`Loop speculation has no promotable winner: ${speculationId}`);
    }
    if (state.status === "promoted") return state;
    const winner = state.candidates.find((item) => item.id === state.winnerId);
    if (!winner?.branch || winner.status !== "passed")
      throw new Error(`Loop speculation winner is invalid: ${state.winnerId}`);
    await promoteManagedLoopWorktree(workspace, winner.branch, "Loop speculation promotion conflict");
    const promoted: LoopSpeculationState = {
      ...state,
      status: "promoted",
      promotedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveState(workspace, promoted);
    return promoted;
  } finally {
    lease.release();
  }
}

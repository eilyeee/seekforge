import { randomUUID } from "node:crypto";
import type { AgentError } from "@seekforge/shared";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  LoopEvent,
  LoopIterationSnapshot,
  LoopStageResult,
  LoopStatus,
  LoopVerificationStage,
} from "./auto-loop.js";
import {
  DEFAULT_LOOP_AGENT_RETRIES,
  DEFAULT_LOOP_AGENT_TIMEOUT_MS,
  DEFAULT_LOOP_VERIFY_TIMEOUT_MS,
  LOOP_LOG_FLUSH_INTERVAL_MS,
  MAX_LOOP_ITERATIONS,
  MAX_LOOP_LOG_BYTES,
  MAX_LOOP_LOG_SEGMENTS,
} from "./loop-constants.js";
import { resolveForWrite, resolveInsideWorkspace } from "../tools/sandbox.js";
import { FileTooLargeError, readUtf8FileBoundedSync } from "../util/fs.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isRecord } from "../util/guards.js";
import {
  isLoopRequirementMode,
  parseLoopAcceptanceReview,
  parseLoopRequirementSpec,
  type LoopAcceptanceReview,
  type LoopRequirementMode,
  type LoopRequirementSpec,
} from "./loop-requirements.js";

export type PersistedLoopStatus = "running" | "paused" | LoopStatus;
export type LoopVerifyResult = { code: number; output: string };
export type LoopState = {
  schemaVersion?: 2;
  loopId: string;
  task: string;
  workspace: string;
  verifyCommand: string;
  verificationPlan?: LoopVerificationStage[];
  stablePasses?: number;
  flakyRetries?: number;
  maxNoProgressRecoveries?: number;
  rollbackOnRegression?: boolean;
  passStreak?: number;
  recoveryAttempts?: number;
  stageResults?: LoopStageResult[];
  snapshots?: LoopIterationSnapshot[];
  maxIterations: number;
  costBudgetUsd: number | null;
  tokenBudget?: number | null;
  maxDurationMs?: number | null;
  maxVerifyRuns?: number | null;
  verifyTimeoutMs?: number;
  agentTimeoutMs?: number;
  maxAgentRetries?: number;
  iterations: number;
  costUsd: number;
  tokensUsed?: number;
  verifyRuns?: number;
  elapsedMs?: number;
  sessionId: string;
  reviewerSessionId?: string;
  lastVerify: LoopVerifyResult | null;
  lastAgentError?: AgentError | null;
  /** Optional in the type so callers can still represent legacy persisted records. */
  requirementMode?: LoopRequirementMode;
  requirements?: LoopRequirementSpec | null;
  acceptanceReview?: LoopAcceptanceReview | null;
  requirementsApprovedAt?: string | null;
  status: PersistedLoopStatus;
  createdAt: string;
  updatedAt: string;
};
export type CreateLoopStateInput = Pick<LoopState, "task" | "workspace" | "verifyCommand" | "maxIterations"> & {
  loopId?: string;
  costBudgetUsd?: number | null;
  tokenBudget?: number | null;
  maxDurationMs?: number | null;
  maxVerifyRuns?: number | null;
  verifyTimeoutMs?: number;
  agentTimeoutMs?: number;
  maxAgentRetries?: number;
  sessionId?: string;
  lastVerify?: LoopVerifyResult | null;
  requirementMode?: LoopRequirementMode;
  verificationPlan?: LoopVerificationStage[];
  stablePasses?: number;
  flakyRetries?: number;
  maxNoProgressRecoveries?: number;
  rollbackOnRegression?: boolean;
};

const LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOOP_STATUSES = new Set<PersistedLoopStatus>([
  "running",
  "paused",
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

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isIsoDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

function parseVerificationPlan(value: unknown): LoopVerificationStage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const ids = new Set<string>();
  const result: LoopVerificationStage[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !LOOP_ID_RE.test(item.id) ||
      ids.has(item.id) ||
      typeof item.command !== "string" ||
      item.command.trim() === "" ||
      item.command.length > 8_192 ||
      (item.required !== undefined && typeof item.required !== "boolean") ||
      (item.timeoutMs !== undefined && (!isSafeInteger(item.timeoutMs) || item.timeoutMs <= 0))
    )
      return null;
    ids.add(item.id);
    result.push({
      id: item.id,
      command: item.command,
      ...(typeof item.required === "boolean" ? { required: item.required } : {}),
      ...(typeof item.timeoutMs === "number" ? { timeoutMs: item.timeoutMs } : {}),
    });
  }
  return result;
}

function parseStageResults(value: unknown): LoopStageResult[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const result: LoopStageResult[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.command !== "string" ||
      !isFiniteNumber(item.code) ||
      !Number.isInteger(item.code) ||
      typeof item.output !== "string" ||
      !isSafeInteger(item.attempts) ||
      item.attempts <= 0 ||
      typeof item.flaky !== "boolean" ||
      !isSafeInteger(item.durationMs) ||
      item.durationMs < 0
    )
      return null;
    result.push(item as LoopStageResult);
  }
  return result;
}

function parseSnapshots(value: unknown): LoopIterationSnapshot[] | null {
  if (!Array.isArray(value) || value.length > MAX_LOOP_ITERATIONS) return null;
  const result: LoopIterationSnapshot[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isSafeInteger(item.iteration) ||
      item.iteration < 0 ||
      !isIsoDate(item.ts) ||
      typeof item.diagnosticsFingerprint !== "string" ||
      (item.workspaceFingerprint !== null && typeof item.workspaceFingerprint !== "string") ||
      !isSafeInteger(item.failedTests) ||
      item.failedTests < 0
    )
      return null;
    const stageResults = parseStageResults(item.stageResults);
    if (stageResults === null) return null;
    result.push({
      iteration: item.iteration,
      ts: item.ts,
      diagnosticsFingerprint: item.diagnosticsFingerprint,
      workspaceFingerprint: item.workspaceFingerprint,
      failedTests: item.failedTests,
      stageResults,
    });
  }
  return result;
}

export function isValidLoopId(loopId: string): boolean {
  return LOOP_ID_RE.test(loopId);
}

function requireWorkspace(workspace: string): string {
  if (!isAbsolute(workspace)) throw new Error("Loop workspace must be an absolute path");
  const absolute = resolve(workspace);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

const loopsRoot = (workspace: string): string =>
  resolveInsideWorkspace(requireWorkspace(workspace), join(".seekforge", "loops"));
function loopFile(workspace: string, loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return resolveForWrite(requireWorkspace(workspace), join(".seekforge", "loops", `${loopId}.json`));
}
function loopLogFile(workspace: string, loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return resolveForWrite(requireWorkspace(workspace), join(".seekforge", "loops", `${loopId}.log`));
}

/**
 * Append one loop event to `.seekforge/loops/<id>.log` as a timestamped JSONL
 * line. Unlike the state JSON (a snapshot, overwritten each save) this is an
 * append-only history of the run, so a resumed loop keeps accumulating into the
 * same file. Best-effort observability: callers swallow failures because losing
 * a log line must never abort the loop, and a broken `.seekforge/loops` write is
 * already surfaced through the state-persistence warning.
 */
export function appendLoopLog(workspace: string, loopId: string, event: LoopEvent): void {
  const writer = createLoopLogWriter(workspace, loopId);
  writer.append(event);
  writer.flush();
}

export type LoopLogWriter = {
  append: (event: LoopEvent) => void;
  flush: () => void;
  close: () => void;
};

export type LoopHistoryEntry = { seq: number; ts: string; event: LoopEvent };

const loopLogSegments = (target: string): string[] =>
  Array.from({ length: MAX_LOOP_LOG_SEGMENTS }, (_, index) => (index === 0 ? target : `${target}.${index}`)).reverse();

function lastLoopSequence(target: string): number {
  let cursor = 0;
  for (const file of loopLogSegments(target)) {
    let raw: string;
    try {
      raw = readUtf8FileBoundedSync(file, MAX_LOOP_LOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      break;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as unknown;
        if (!isRecord(row)) break;
        cursor = isSafeInteger(row.seq) && row.seq > cursor ? row.seq : cursor + 1;
      } catch {
        break;
      }
    }
  }
  return cursor;
}

/** Reads the bounded current + rotated Loop JSONL history in chronological order. */
export function readLoopHistory(
  workspace: string,
  loopId: string,
  options: { afterSeq?: number; limit?: number } = {},
): LoopHistoryEntry[] {
  const target = loopLogFile(workspace, loopId);
  const afterSeq = Number.isSafeInteger(options.afterSeq) && options.afterSeq! >= 0 ? options.afterSeq! : 0;
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit!, 2_000)) : 500;
  const eventTypes = new Set([
    "iteration.start",
    "run.completed",
    "verify.output",
    "verify",
    "verify.stage.started",
    "verify.stage.completed",
    "verify.flaky",
    "loop.paused",
    "loop.resumed",
    "loop.steered",
    "loop.recovery",
    "loop.snapshot",
    "loop.rollback",
    "requirements.started",
    "requirements.completed",
    "requirements.reviewed",
    "loop.warning",
    "loop.done",
  ]);
  const result: LoopHistoryEntry[] = [];
  let cursor = 0;
  for (const file of loopLogSegments(target)) {
    let raw: string;
    try {
      raw = readUtf8FileBoundedSync(file, MAX_LOOP_LOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      break;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let row: unknown;
      try {
        row = JSON.parse(line) as unknown;
      } catch {
        break;
      }
      if (!isRecord(row) || !isIsoDate(row.ts) || typeof row.type !== "string" || !eventTypes.has(row.type)) break;
      cursor = isSafeInteger(row.seq) && row.seq > cursor ? row.seq : cursor + 1;
      if (cursor <= afterSeq) continue;
      const { ts, seq: _seq, ...event } = row;
      result.push({ seq: cursor, ts: ts as string, event: event as LoopEvent });
      if (result.length >= limit) return result;
    }
  }
  return result;
}

/** Batches event writes and rotates bounded log segments before appending. */
export function createLoopLogWriter(workspace: string, loopId: string): LoopLogWriter {
  const target = loopLogFile(workspace, loopId);
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let sequence = lastLoopSequence(target);

  const rotate = (incomingBytes: number): void => {
    let currentBytes = 0;
    try {
      currentBytes = statSync(target).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentBytes === 0 || currentBytes + incomingBytes <= MAX_LOOP_LOG_BYTES) return;
    for (let segment = MAX_LOOP_LOG_SEGMENTS - 1; segment >= 1; segment--) {
      const source = segment === 1 ? target : `${target}.${segment - 1}`;
      const destination = `${target}.${segment}`;
      try {
        rmSync(destination, { force: true });
        renameSync(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };

  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending === "") return;
    const batch = pending;
    pending = "";
    mkdirSync(dirname(target), { recursive: true });
    rotate(Buffer.byteLength(batch));
    appendFileSync(target, batch, { encoding: "utf8", mode: 0o600 });
  };

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      try {
        flush();
      } catch {
        // Scheduled observability writes are best-effort and cannot fail the loop.
      }
    }, LOOP_LOG_FLUSH_INTERVAL_MS);
    timer.unref?.();
  };

  return {
    append: (event) => {
      if (closed) return;
      pending += `${JSON.stringify({ seq: ++sequence, ts: new Date().toISOString(), ...event })}\n`;
      if (Buffer.byteLength(pending) >= 64 * 1024) flush();
      else schedule();
    },
    flush,
    close: () => {
      if (closed) return;
      closed = true;
      flush();
    },
  };
}

const activeLeases = new Set<string>();

export type LoopLease = { release: () => void };

const leaseKey = (workspace: string, loopId: string): string => `${requireWorkspace(workspace)}\0${loopId}`;

function leaseFile(workspace: string, loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return resolveForWrite(requireWorkspace(workspace), join(".seekforge", "loops", `.${loopId}.lock`));
}

type LockSnapshot = { content: string; alive: boolean };
const MALFORMED_LOCK_GRACE_MS = 30_000;
const MAX_LOOP_LOCK_BYTES = 16 * 1024;
const MAX_LOOP_STATE_BYTES = 1024 * 1024;
const MAX_PROC_STAT_BYTES = 64 * 1024;

function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readUtf8FileBoundedSync(`/proc/${pid}/stat`, MAX_PROC_STAT_BYTES);
      const closeParen = stat.lastIndexOf(")");
      const fields = stat.slice(closeParen + 2).split(" ");
      return fields[19] ? `linux:${fields[19]}` : undefined;
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
      const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
      if (started) return `${process.platform}:${started}`;
    }
  } catch {
    // Fall through to the current-process identity when OS inspection is unavailable.
  }
  if (pid === process.pid) return `portable:${Math.floor((Date.now() - process.uptime() * 1_000) / 1_000)}`;
  return undefined;
}

const selfProcessIdentity = processIdentity(process.pid);

function readLockSnapshot(target: string): LockSnapshot {
  let content: string;
  try {
    content = readUtf8FileBoundedSync(target, MAX_LOOP_LOCK_BYTES);
  } catch (error) {
    if (!(error instanceof FileTooLargeError)) throw error;
    const stat = statSync(target);
    return {
      content: `oversized:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
      alive: Date.now() - stat.mtimeMs < MALFORMED_LOCK_GRACE_MS,
    };
  }
  let owner: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return { content, alive: Date.now() - statSync(target).mtimeMs < MALFORMED_LOCK_GRACE_MS };
    }
    owner = parsed;
  } catch {
    return { content, alive: Date.now() - statSync(target).mtimeMs < MALFORMED_LOCK_GRACE_MS };
  }
  if (
    !Number.isInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.token !== "string" ||
    (owner.createdAt !== undefined &&
      (typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))))
  ) {
    return { content, alive: Date.now() - statSync(target).mtimeMs < MALFORMED_LOCK_GRACE_MS };
  }
  try {
    process.kill(owner.pid as number, 0);
    if (typeof owner.processIdentity === "string") {
      const currentIdentity = processIdentity(owner.pid as number);
      if (currentIdentity !== undefined && currentIdentity !== owner.processIdentity) return { content, alive: false };
    }
    return { content, alive: true };
  } catch (error) {
    return { content, alive: (error as NodeJS.ErrnoException).code !== "ESRCH" };
  }
}

function removeStaleLock(target: string, expectedContent: string): boolean {
  try {
    if (readLockSnapshot(target).content !== expectedContent) return false;
    rmSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return true;
  }
}

/** Returns whether a live process-local or filesystem lease owns this loop. */
export function isLoopLeaseActive(workspace: string, loopId: string): boolean {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  if (activeLeases.has(leaseKey(workspace, loopId))) return true;
  const target = leaseFile(workspace, loopId);
  try {
    return readLockSnapshot(target).alive;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Returns whether any live Loop lease exists in this workspace. */
export function hasActiveLoopLease(workspace: string): boolean {
  const prefix = `${requireWorkspace(workspace)}\0`;
  if ([...activeLeases].some((key) => key.startsWith(prefix))) return true;
  let names: string[];
  try {
    names = readdirSync(loopsRoot(workspace));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    const match = /^\.(.+)\.lock$/.exec(name);
    if (!match?.[1]) continue;
    if (!isValidLoopId(match[1])) return true;
    if (isLoopLeaseActive(workspace, match[1])) return true;
  }
  return false;
}

/**
 * Acquires a process- and filesystem-wide lease. A dead PID is stale; release
 * verifies its random token so an old owner can never remove a successor lock.
 */
export function acquireLoopLease(workspace: string, loopId: string, persist: boolean): LoopLease {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  const key = leaseKey(workspace, loopId);
  if (activeLeases.has(key)) throw new Error(`Loop is already running: ${loopId}`);
  activeLeases.add(key);
  if (!persist)
    return {
      release: () => {
        activeLeases.delete(key);
      },
    };

  try {
    const target = leaseFile(workspace, loopId);
    mkdirSync(dirname(target), { recursive: true });
    const token = randomUUID();
    const payload = JSON.stringify({
      version: 1,
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
      ...(selfProcessIdentity ? { processIdentity: selfProcessIdentity } : {}),
    });
    const recoveryTarget = `${target}.recovery`;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (existsSync(recoveryTarget)) {
        const recovery = readLockSnapshot(recoveryTarget);
        if (recovery.alive) throw new Error(`Loop lease recovery is already running: ${loopId}`);
        removeStaleLock(recoveryTarget, recovery.content);
        continue;
      }
      try {
        const fd = openSync(target, "wx", 0o600);
        try {
          writeFileSync(fd, payload, "utf8");
        } catch (error) {
          try {
            closeSync(fd);
          } finally {
            rmSync(target, { force: true });
          }
          throw error;
        }
        closeSync(fd);
        if (existsSync(recoveryTarget)) {
          try {
            const owner = JSON.parse(readUtf8FileBoundedSync(target, MAX_LOOP_LOCK_BYTES)) as { token?: unknown };
            if (owner.token === token) rmSync(target);
          } catch {
            /* A recovery contender replaced or removed this candidate. */
          }
          continue;
        }
        return {
          release: () => {
            activeLeases.delete(key);
            try {
              const owner = JSON.parse(readUtf8FileBoundedSync(target, MAX_LOOP_LOCK_BYTES)) as { token?: unknown };
              if (owner.token === token) rmSync(target);
            } catch {
              /* A missing/replaced lock no longer belongs to this lease. */
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const snapshot = readLockSnapshot(target);
        if (snapshot.alive) throw new Error(`Loop is already running: ${loopId}`);
        let recoveryFd: number;
        try {
          recoveryFd = openSync(recoveryTarget, "wx", 0o600);
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw recoveryError;
        }
        try {
          writeFileSync(recoveryFd, payload, "utf8");
        } finally {
          closeSync(recoveryFd);
        }
        try {
          const current = readLockSnapshot(target);
          if (!current.alive && current.content === snapshot.content) removeStaleLock(target, current.content);
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
        } finally {
          try {
            const owner = JSON.parse(readUtf8FileBoundedSync(recoveryTarget, MAX_LOOP_LOCK_BYTES)) as {
              token?: unknown;
            };
            if (owner.token === token) rmSync(recoveryTarget);
          } catch {
            /* A missing/replaced recovery marker no longer belongs to this process. */
          }
        }
      }
    }
    throw new Error(`Could not acquire loop lease: ${loopId}`);
  } catch (error) {
    activeLeases.delete(key);
    throw error;
  }
}

function parseLoopState(value: unknown, expectedWorkspace?: string): LoopState | null {
  if (!isRecord(value)) return null;
  const budget = value.costBudgetUsd;
  const tokenBudget = value.tokenBudget === undefined ? null : value.tokenBudget;
  const maxDurationMs = value.maxDurationMs === undefined ? null : value.maxDurationMs;
  const maxVerifyRuns = value.maxVerifyRuns === undefined ? null : value.maxVerifyRuns;
  const verifyTimeoutMs = value.verifyTimeoutMs === undefined ? DEFAULT_LOOP_VERIFY_TIMEOUT_MS : value.verifyTimeoutMs;
  const agentTimeoutMs = value.agentTimeoutMs === undefined ? DEFAULT_LOOP_AGENT_TIMEOUT_MS : value.agentTimeoutMs;
  const maxAgentRetries = value.maxAgentRetries === undefined ? DEFAULT_LOOP_AGENT_RETRIES : value.maxAgentRetries;
  const tokensUsed = value.tokensUsed === undefined ? 0 : value.tokensUsed;
  const verifyRuns = value.verifyRuns === undefined ? 0 : value.verifyRuns;
  const elapsedMs = value.elapsedMs === undefined ? 0 : value.elapsedMs;
  const reviewerSessionId = value.reviewerSessionId === undefined ? "" : value.reviewerSessionId;
  const verify = value.lastVerify;
  const agentError = value.lastAgentError === undefined ? null : value.lastAgentError;
  const requirementMode = value.requirementMode === undefined ? "quick" : value.requirementMode;
  const requirements = value.requirements === undefined ? null : parseLoopRequirementSpec(value.requirements);
  const acceptanceReview =
    value.acceptanceReview === undefined || value.acceptanceReview === null || requirements === null
      ? null
      : parseLoopAcceptanceReview(value.acceptanceReview, requirements);
  const requirementsApprovedAt = value.requirementsApprovedAt === undefined ? null : value.requirementsApprovedAt;
  const verificationPlan =
    value.verificationPlan === undefined ? undefined : parseVerificationPlan(value.verificationPlan);
  const stablePasses = value.stablePasses === undefined ? 1 : value.stablePasses;
  const flakyRetries = value.flakyRetries === undefined ? 0 : value.flakyRetries;
  const maxNoProgressRecoveries = value.maxNoProgressRecoveries === undefined ? 1 : value.maxNoProgressRecoveries;
  const passStreak = value.passStreak === undefined ? 0 : value.passStreak;
  const recoveryAttempts = value.recoveryAttempts === undefined ? 0 : value.recoveryAttempts;
  const stageResults = value.stageResults === undefined ? [] : parseStageResults(value.stageResults);
  const snapshots = value.snapshots === undefined ? [] : parseSnapshots(value.snapshots);
  const rollbackOnRegression = value.rollbackOnRegression === undefined ? false : value.rollbackOnRegression;
  if (
    (value.schemaVersion !== undefined && value.schemaVersion !== 2) ||
    typeof value.loopId !== "string" ||
    !isValidLoopId(value.loopId) ||
    typeof value.task !== "string" ||
    typeof value.workspace !== "string" ||
    !isAbsolute(value.workspace) ||
    typeof value.verifyCommand !== "string" ||
    (value.verificationPlan !== undefined && verificationPlan === null) ||
    !isSafeInteger(stablePasses) ||
    stablePasses <= 0 ||
    stablePasses > 5 ||
    !isSafeInteger(flakyRetries) ||
    flakyRetries < 0 ||
    flakyRetries > 5 ||
    !isSafeInteger(maxNoProgressRecoveries) ||
    maxNoProgressRecoveries < 0 ||
    maxNoProgressRecoveries > 5 ||
    !isSafeInteger(passStreak) ||
    passStreak < 0 ||
    passStreak > stablePasses ||
    !isSafeInteger(recoveryAttempts) ||
    recoveryAttempts < 0 ||
    recoveryAttempts > maxNoProgressRecoveries ||
    stageResults === null ||
    snapshots === null ||
    typeof rollbackOnRegression !== "boolean" ||
    !Number.isInteger(value.maxIterations) ||
    !isFiniteNumber(value.maxIterations) ||
    value.maxIterations <= 0 ||
    value.maxIterations > MAX_LOOP_ITERATIONS ||
    (budget !== null && (!isFiniteNumber(budget) || budget <= 0)) ||
    (tokenBudget !== null && (!isSafeInteger(tokenBudget) || tokenBudget <= 0)) ||
    (maxDurationMs !== null && (!isSafeInteger(maxDurationMs) || maxDurationMs <= 0)) ||
    (maxVerifyRuns !== null && (!isSafeInteger(maxVerifyRuns) || maxVerifyRuns <= 0)) ||
    !isSafeInteger(verifyTimeoutMs) ||
    verifyTimeoutMs <= 0 ||
    !isSafeInteger(agentTimeoutMs) ||
    agentTimeoutMs <= 0 ||
    !isSafeInteger(maxAgentRetries) ||
    maxAgentRetries < 0 ||
    !Number.isInteger(value.iterations) ||
    !isFiniteNumber(value.iterations) ||
    value.iterations < 0 ||
    value.iterations > value.maxIterations ||
    !isFiniteNumber(value.costUsd) ||
    value.costUsd < 0 ||
    !isSafeInteger(tokensUsed) ||
    tokensUsed < 0 ||
    !isSafeInteger(verifyRuns) ||
    verifyRuns < 0 ||
    (maxVerifyRuns !== null && verifyRuns > maxVerifyRuns) ||
    !isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    typeof value.sessionId !== "string" ||
    typeof reviewerSessionId !== "string" ||
    (verify !== null &&
      (!isRecord(verify) ||
        !Number.isInteger(verify.code) ||
        !isFiniteNumber(verify.code) ||
        typeof verify.output !== "string")) ||
    (agentError !== null &&
      (!isRecord(agentError) ||
        typeof agentError.code !== "string" ||
        typeof agentError.message !== "string" ||
        (agentError.hint !== undefined && typeof agentError.hint !== "string") ||
        (agentError.recoverable !== undefined && typeof agentError.recoverable !== "boolean") ||
        (agentError.sessionId !== undefined && typeof agentError.sessionId !== "string"))) ||
    !isLoopRequirementMode(requirementMode) ||
    (value.requirements !== undefined && value.requirements !== null && requirements === null) ||
    (value.acceptanceReview !== undefined && value.acceptanceReview !== null && acceptanceReview === null) ||
    (requirementsApprovedAt !== null && !isIsoDate(requirementsApprovedAt)) ||
    (requirementMode === "quick" && (requirements !== null || acceptanceReview !== null)) ||
    (requirementsApprovedAt !== null && (requirementMode !== "confirm" || requirements === null)) ||
    (requirementMode === "confirm" && acceptanceReview !== null && requirementsApprovedAt === null) ||
    (value.status === "requirements_pending" &&
      (requirementMode !== "confirm" ||
        requirements === null ||
        requirementsApprovedAt !== null ||
        acceptanceReview !== null)) ||
    (requirementMode !== "quick" && acceptanceReview !== null && requirements === null) ||
    typeof value.status !== "string" ||
    !LOOP_STATUSES.has(value.status as PersistedLoopStatus) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  )
    return null;

  const workspace = requireWorkspace(value.workspace);
  if (expectedWorkspace !== undefined && workspace !== requireWorkspace(expectedWorkspace)) return null;
  return {
    schemaVersion: 2,
    loopId: value.loopId,
    task: value.task,
    workspace,
    verifyCommand: value.verifyCommand,
    ...(verificationPlan ? { verificationPlan } : {}),
    stablePasses: stablePasses as number,
    flakyRetries: flakyRetries as number,
    maxNoProgressRecoveries: maxNoProgressRecoveries as number,
    passStreak: passStreak as number,
    recoveryAttempts: recoveryAttempts as number,
    stageResults: stageResults as LoopStageResult[],
    snapshots: snapshots as LoopIterationSnapshot[],
    rollbackOnRegression,
    maxIterations: value.maxIterations,
    costBudgetUsd: budget,
    tokenBudget: tokenBudget as number | null,
    maxDurationMs: maxDurationMs as number | null,
    maxVerifyRuns: maxVerifyRuns as number | null,
    verifyTimeoutMs: verifyTimeoutMs as number,
    agentTimeoutMs: agentTimeoutMs as number,
    maxAgentRetries: maxAgentRetries as number,
    iterations: value.iterations,
    costUsd: value.costUsd,
    tokensUsed: tokensUsed as number,
    verifyRuns: verifyRuns as number,
    elapsedMs: elapsedMs as number,
    sessionId: value.sessionId,
    reviewerSessionId,
    lastVerify: verify === null ? null : { code: verify.code as number, output: verify.output as string },
    lastAgentError:
      agentError === null
        ? null
        : {
            code: agentError.code as string,
            message: agentError.message as string,
            ...(typeof agentError.hint === "string" ? { hint: agentError.hint } : {}),
            ...(typeof agentError.recoverable === "boolean" ? { recoverable: agentError.recoverable } : {}),
            ...(typeof agentError.sessionId === "string" ? { sessionId: agentError.sessionId } : {}),
          },
    requirementMode,
    requirements,
    acceptanceReview,
    requirementsApprovedAt,
    status: value.status as PersistedLoopStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function createLoopState(input: CreateLoopStateInput): LoopState {
  if (input.loopId !== undefined && !isValidLoopId(input.loopId)) {
    throw new Error(`Invalid loop id: ${input.loopId}`);
  }
  const now = new Date().toISOString();
  const id = input.loopId ?? `loop-${randomUUID()}`;
  if (existsSync(loopFile(input.workspace, id))) {
    throw new Error(`Loop state already exists: ${id}`);
  }
  const state: LoopState = {
    schemaVersion: 2,
    loopId: id,
    task: input.task,
    workspace: requireWorkspace(input.workspace),
    verifyCommand: input.verifyCommand,
    ...(input.verificationPlan ? { verificationPlan: input.verificationPlan } : {}),
    stablePasses: input.stablePasses ?? 1,
    flakyRetries: input.flakyRetries ?? 0,
    maxNoProgressRecoveries: input.maxNoProgressRecoveries ?? 1,
    passStreak: 0,
    recoveryAttempts: 0,
    stageResults: [],
    snapshots: [],
    rollbackOnRegression: input.rollbackOnRegression ?? false,
    maxIterations: input.maxIterations,
    costBudgetUsd: input.costBudgetUsd ?? null,
    tokenBudget: input.tokenBudget ?? null,
    maxDurationMs: input.maxDurationMs ?? null,
    maxVerifyRuns: input.maxVerifyRuns ?? null,
    verifyTimeoutMs: input.verifyTimeoutMs ?? DEFAULT_LOOP_VERIFY_TIMEOUT_MS,
    agentTimeoutMs: input.agentTimeoutMs ?? DEFAULT_LOOP_AGENT_TIMEOUT_MS,
    maxAgentRetries: input.maxAgentRetries ?? DEFAULT_LOOP_AGENT_RETRIES,
    iterations: 0,
    costUsd: 0,
    tokensUsed: 0,
    verifyRuns: 0,
    elapsedMs: 0,
    sessionId: input.sessionId ?? "",
    reviewerSessionId: "",
    lastVerify: input.lastVerify ?? null,
    lastAgentError: null,
    requirementMode: input.requirementMode ?? "quick",
    requirements: null,
    acceptanceReview: null,
    requirementsApprovedAt: null,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  saveLoopState(state.workspace, state);
  return state;
}

export function saveLoopState(workspace: string, state: LoopState): void {
  const normalized = parseLoopState(state, workspace);
  if (!normalized) throw new Error("Invalid loop state");
  writeWorkspaceStateFileAtomic(
    requireWorkspace(workspace),
    join(".seekforge", "loops", `${normalized.loopId}.json`),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
}

export function loadLoopState(workspace: string, loopId: string): LoopState | null {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  try {
    const raw = readWorkspaceStateFile(
      requireWorkspace(workspace),
      join(".seekforge", "loops", `${loopId}.json`),
      MAX_LOOP_STATE_BYTES,
    );
    return raw === undefined ? null : parseLoopState(JSON.parse(raw) as unknown, workspace);
  } catch {
    return null;
  }
}

export function listLoopStates(workspace: string): LoopState[] {
  let names: string[];
  try {
    names = readdirSync(loopsRoot(workspace));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => loadLoopState(workspace, name.slice(0, -5)))
    .filter((state): state is LoopState => state !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Marks durable running or paused records whose process/lease disappeared as resumable interruptions. */
export function recoverInterruptedLoops(workspace: string): LoopState[] {
  const recovered: LoopState[] = [];
  for (const state of listLoopStates(workspace)) {
    if ((state.status !== "running" && state.status !== "paused") || isLoopLeaseActive(workspace, state.loopId))
      continue;
    const next = { ...state, status: "interrupted" as const, updatedAt: new Date().toISOString() };
    saveLoopState(workspace, next);
    recovered.push(next);
  }
  return recovered;
}

export function removeLoopState(workspace: string, loopId: string): boolean {
  if (isLoopLeaseActive(workspace, loopId)) {
    throw new Error(`Cannot remove running loop: ${loopId}`);
  }
  try {
    rmSync(loopFile(workspace, loopId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  rmSync(loopLogFile(workspace, loopId), { force: true });
  for (let segment = 1; segment < MAX_LOOP_LOG_SEGMENTS; segment++) {
    rmSync(`${loopLogFile(workspace, loopId)}.${segment}`, { force: true });
  }
  return true;
}

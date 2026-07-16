import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LoopEvent, LoopStatus } from "./auto-loop.js";
import { MAX_LOOP_ITERATIONS } from "./loop-constants.js";
import { resolveForWrite, resolveInsideWorkspace } from "../tools/sandbox.js";
import { isRecord } from "../util/guards.js";

export type PersistedLoopStatus = "running" | LoopStatus;
export type LoopVerifyResult = { code: number; output: string };
export type LoopState = {
  loopId: string;
  task: string;
  workspace: string;
  verifyCommand: string;
  maxIterations: number;
  costBudgetUsd: number | null;
  iterations: number;
  costUsd: number;
  sessionId: string;
  lastVerify: LoopVerifyResult | null;
  status: PersistedLoopStatus;
  createdAt: string;
  updatedAt: string;
};
export type CreateLoopStateInput = Pick<LoopState, "task" | "workspace" | "verifyCommand" | "maxIterations"> & {
  loopId?: string;
  costBudgetUsd?: number | null;
  sessionId?: string;
  lastVerify?: LoopVerifyResult | null;
};

const LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOOP_STATUSES = new Set<PersistedLoopStatus>([
  "running",
  "passed",
  "exhausted",
  "no_progress",
  "budget",
  "cancelled",
  "verify_error",
]);

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isIsoDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

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
  const target = loopLogFile(workspace, loopId);
  mkdirSync(dirname(target), { recursive: true });
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  appendFileSync(target, line, { encoding: "utf8", mode: 0o600 });
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

function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
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
  const content = readFileSync(target, "utf8");
  let owner: { pid?: unknown; token?: unknown; processIdentity?: unknown; createdAt?: unknown };
  try {
    owner = JSON.parse(content) as typeof owner;
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
    if (readFileSync(target, "utf8") !== expectedContent) return false;
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = readLockSnapshot(target);
      if (snapshot.alive) return true;
      if (removeStaleLock(target, snapshot.content)) return false;
    }
    return true;
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
    for (let attempt = 0; attempt < 3; attempt++) {
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
        return {
          release: () => {
            activeLeases.delete(key);
            try {
              const owner = JSON.parse(readFileSync(target, "utf8")) as { token?: unknown };
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
        if (!removeStaleLock(target, snapshot.content)) continue;
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
  const verify = value.lastVerify;
  if (
    typeof value.loopId !== "string" ||
    !isValidLoopId(value.loopId) ||
    typeof value.task !== "string" ||
    typeof value.workspace !== "string" ||
    !isAbsolute(value.workspace) ||
    typeof value.verifyCommand !== "string" ||
    !Number.isInteger(value.maxIterations) ||
    !isFiniteNumber(value.maxIterations) ||
    value.maxIterations <= 0 ||
    value.maxIterations > MAX_LOOP_ITERATIONS ||
    (budget !== null && (!isFiniteNumber(budget) || budget <= 0)) ||
    !Number.isInteger(value.iterations) ||
    !isFiniteNumber(value.iterations) ||
    value.iterations < 0 ||
    value.iterations > value.maxIterations ||
    !isFiniteNumber(value.costUsd) ||
    value.costUsd < 0 ||
    typeof value.sessionId !== "string" ||
    (verify !== null &&
      (!isRecord(verify) ||
        !Number.isInteger(verify.code) ||
        !isFiniteNumber(verify.code) ||
        typeof verify.output !== "string")) ||
    typeof value.status !== "string" ||
    !LOOP_STATUSES.has(value.status as PersistedLoopStatus) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  )
    return null;

  const workspace = requireWorkspace(value.workspace);
  if (expectedWorkspace !== undefined && workspace !== requireWorkspace(expectedWorkspace)) return null;
  return {
    loopId: value.loopId,
    task: value.task,
    workspace,
    verifyCommand: value.verifyCommand,
    maxIterations: value.maxIterations,
    costBudgetUsd: budget,
    iterations: value.iterations,
    costUsd: value.costUsd,
    sessionId: value.sessionId,
    lastVerify: verify === null ? null : { code: verify.code as number, output: verify.output as string },
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
    loopId: id,
    task: input.task,
    workspace: requireWorkspace(input.workspace),
    verifyCommand: input.verifyCommand,
    maxIterations: input.maxIterations,
    costBudgetUsd: input.costBudgetUsd ?? null,
    iterations: 0,
    costUsd: 0,
    sessionId: input.sessionId ?? "",
    lastVerify: input.lastVerify ?? null,
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
  const target = loopFile(workspace, normalized.loopId);
  const root = dirname(target);
  mkdirSync(root, { recursive: true });
  const temp = join(root, `.${normalized.loopId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function loadLoopState(workspace: string, loopId: string): LoopState | null {
  const file = loopFile(workspace, loopId);
  try {
    return parseLoopState(JSON.parse(readFileSync(file, "utf8")) as unknown, workspace);
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
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  return true;
}

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LoopStatus } from "./auto-loop.js";
import { MAX_LOOP_ITERATIONS } from "./loop-constants.js";
import { resolveForWrite, resolveInsideWorkspace } from "../tools/sandbox.js";

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
  "running", "passed", "exhausted", "no_progress", "budget", "cancelled", "verify_error",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export function isValidLoopId(loopId: string): boolean {
  return LOOP_ID_RE.test(loopId);
}

function requireWorkspace(workspace: string): string {
  if (!isAbsolute(workspace)) throw new Error("Loop workspace must be an absolute path");
  return resolve(workspace);
}

const loopsRoot = (workspace: string): string =>
  resolveInsideWorkspace(requireWorkspace(workspace), join(".seekforge", "loops"));
function loopFile(workspace: string, loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return resolveForWrite(requireWorkspace(workspace), join(".seekforge", "loops", `${loopId}.json`));
}

const activeLeases = new Set<string>();

export type LoopLease = { release: () => void };

/**
 * Acquires a process- and filesystem-wide lease. A dead PID is stale; release
 * verifies its random token so an old owner can never remove a successor lock.
 */
export function acquireLoopLease(workspace: string, loopId: string, persist: boolean): LoopLease {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  const key = `${requireWorkspace(workspace)}\0${loopId}`;
  if (activeLeases.has(key)) throw new Error(`Loop is already running: ${loopId}`);
  activeLeases.add(key);
  if (!persist) return { release: () => { activeLeases.delete(key); } };

  const target = resolveForWrite(requireWorkspace(workspace), join(".seekforge", "loops", `.${loopId}.lock`));
  mkdirSync(dirname(target), { recursive: true });
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(target, "wx", 0o600);
        try { writeFileSync(fd, payload, "utf8"); } finally { closeSync(fd); }
        return {
          release: () => {
            activeLeases.delete(key);
            try {
              const owner = JSON.parse(readFileSync(target, "utf8")) as { token?: unknown };
              if (owner.token === token) rmSync(target);
            } catch { /* A missing/replaced lock no longer belongs to this lease. */ }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = JSON.parse(readFileSync(target, "utf8")) as { pid?: unknown };
          if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) stale = true;
          else {
            try { process.kill(owner.pid as number, 0); }
            catch (killError) { stale = (killError as NodeJS.ErrnoException).code === "ESRCH"; }
          }
        } catch {
          throw new Error(`Loop is already running: ${loopId}`);
        }
        if (!stale) throw new Error(`Loop is already running: ${loopId}`);
        try { rmSync(target); } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
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
  const verify = value.lastVerify;
  if (
    typeof value.loopId !== "string" || !isValidLoopId(value.loopId) ||
    typeof value.task !== "string" || typeof value.workspace !== "string" || !isAbsolute(value.workspace) ||
    typeof value.verifyCommand !== "string" || !Number.isInteger(value.maxIterations) ||
    !isFiniteNumber(value.maxIterations) || value.maxIterations <= 0 || value.maxIterations > MAX_LOOP_ITERATIONS ||
    (budget !== null && (!isFiniteNumber(budget) || budget <= 0)) ||
    !Number.isInteger(value.iterations) || !isFiniteNumber(value.iterations) || value.iterations < 0 ||
    value.iterations > value.maxIterations || !isFiniteNumber(value.costUsd) || value.costUsd < 0 ||
    typeof value.sessionId !== "string" ||
    (verify !== null && (!isRecord(verify) || !Number.isInteger(verify.code) ||
      !isFiniteNumber(verify.code) || typeof verify.output !== "string")) ||
    typeof value.status !== "string" || !LOOP_STATUSES.has(value.status as PersistedLoopStatus) ||
    !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)
  ) return null;

  const workspace = resolve(value.workspace);
  if (expectedWorkspace !== undefined && workspace !== requireWorkspace(expectedWorkspace)) return null;
  return {
    loopId: value.loopId, task: value.task, workspace, verifyCommand: value.verifyCommand,
    maxIterations: value.maxIterations, costBudgetUsd: budget, iterations: value.iterations,
    costUsd: value.costUsd, sessionId: value.sessionId,
    lastVerify: verify === null ? null : { code: verify.code as number, output: verify.output as string },
    status: value.status as PersistedLoopStatus, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

export function createLoopState(input: CreateLoopStateInput): LoopState {
  if (input.loopId !== undefined && !isValidLoopId(input.loopId)) {
    throw new Error(`Invalid loop id: ${input.loopId}`);
  }
  const now = new Date().toISOString();
  const state: LoopState = {
    loopId: input.loopId ?? `loop-${randomUUID()}`, task: input.task,
    workspace: requireWorkspace(input.workspace), verifyCommand: input.verifyCommand,
    maxIterations: input.maxIterations, costBudgetUsd: input.costBudgetUsd ?? null,
    iterations: 0, costUsd: 0, sessionId: input.sessionId ?? "",
    lastVerify: input.lastVerify ?? null, status: "running", createdAt: now, updatedAt: now,
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
  } catch { return null; }
}

export function listLoopStates(workspace: string): LoopState[] {
  let names: string[];
  try { names = readdirSync(loopsRoot(workspace)); } catch { return []; }
  return names.filter((name) => name.endsWith(".json"))
    .map((name) => loadLoopState(workspace, name.slice(0, -5)))
    .filter((state): state is LoopState => state !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function removeLoopState(workspace: string, loopId: string): boolean {
  try { rmSync(loopFile(workspace, loopId)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

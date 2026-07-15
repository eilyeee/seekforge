/**
 * Local scheduled-job registry + schedule parsing (Track E automation).
 *
 * This module is deliberately PURE + I/O-light so it can be unit-tested without
 * spending API money: interval/cron parsing, due-time calculation, job
 * validation, and add/list/remove/enable/disable operate on plain values. Disk
 * I/O is confined to `loadRegistry`/`saveRegistry`, which take an explicit
 * project path so tests can point them at a temp dir.
 *
 * SAFETY: a scheduled job runs the agent autonomously, so `maxCostUsd` is
 * REQUIRED and must be a positive finite number — `validateJobInput` rejects a
 * job without it. The command layer (commands/schedule.ts) additionally runs
 * every tick headless (machine output → interactive prompts auto-deny, dangerous
 * stays denied) and enforces the per-job budget via the existing run path.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateDirectory, projectStateFilePath, readProjectStateFile, writeProjectStateFile } from "./project-state.js";

/** ask = read-only Q&A; edit = may modify files (edits auto-approved headless). */
export type ScheduleMode = "ask" | "edit";

export type Job = {
  /** Stable identifier (slug); unique within a registry. */
  id: string;
  /** The prompt the agent runs each tick. */
  task: string;
  /** Either an interval ("30m" / "2h" / "1d") or a 5-field cron string. */
  schedule: string;
  mode: ScheduleMode;
  /** REQUIRED per-run cost cap in USD (> 0). A scheduled run must be bounded. */
  maxCostUsd: number;
  /** ISO timestamp of the last tick that ran this job (absent = never run). */
  lastRunAt?: string;
  /** Consecutive failed attempts; drives bounded exponential retry backoff. */
  failureCount?: number;
  /** Earliest retry time after a failed attempt. */
  nextRetryAt?: string;
  enabled: boolean;
};

export type Registry = { jobs: Job[] };

// --- registry paths + disk I/O ---------------------------------------------

/** Path to the project-scoped registry file (`.seekforge/schedules.json`). */
export function scheduleFilePath(projectPath: string): string {
  return projectStateFilePath(projectPath, "schedules.json");
}

function scheduleLeasePath(projectPath: string): string {
  return join(projectStateDirectory(projectPath), "schedules.lock");
}

type LeaseOwner = { pid: number; token: string; acquiredAt: string; processIdentity?: string };
const MALFORMED_LOCK_GRACE_MS = 30_000;
const portableSelfStart = `portable:${Math.floor((Date.now() - process.uptime() * 1_000) / 1_000)}`;

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
    // Fall through to the portable identity for this process only.
  }
  return pid === process.pid ? portableSelfStart : undefined;
}

const selfProcessIdentity = processIdentity(process.pid);

function readLeaseOwner(leasePath: string): LeaseOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const owner = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(owner["pid"]) || (owner["pid"] as number) <= 0) return null;
    if (typeof owner["token"] !== "string" || typeof owner["acquiredAt"] !== "string") return null;
    if (owner["processIdentity"] !== undefined && typeof owner["processIdentity"] !== "string") return null;
    return owner as LeaseOwner;
  } catch {
    return null;
  }
}

function processIsOwner(owner: LeaseOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    if (owner.processIdentity !== undefined) {
      const current = processIdentity(owner.pid);
      if (current !== undefined && current !== owner.processIdentity) return false;
    }
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the project scheduler lease. Atomic directory creation excludes
 * overlapping ticks; a lock owned by a dead process is renamed away and
 * recovered. The short malformed-lock grace covers a process between mkdir
 * and writing its owner metadata.
 */
export function acquireScheduleLease(projectPath: string): (() => void) | null {
  const leasePath = scheduleLeasePath(projectPath);
  const recoveryPath = `${leasePath}.recovery`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const finishClaim = (): (() => void) => {
    try {
      writeFileSync(
        join(leasePath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
          ...(selfProcessIdentity ? { processIdentity: selfProcessIdentity } : {}),
        })}\n`,
        "utf8",
      );
      return () => {
        if (readLeaseOwner(leasePath)?.token === token) rmSync(leasePath, { recursive: true, force: true });
      };
    } catch (err) {
      rmSync(leasePath, { recursive: true, force: true });
      throw err;
    }
  };

  try {
    mkdirSync(leasePath);
    return finishClaim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Only one contender may inspect and replace a stale lease. Holding this
  // recovery directory through the replacement prevents another recovery
  // process from renaming the newly acquired lease.
  try {
    mkdirSync(recoveryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      let fresh = true;
      try {
        fresh = Date.now() - statSync(recoveryPath).mtimeMs < MALFORMED_LOCK_GRACE_MS;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") return acquireScheduleLease(projectPath);
        throw statErr;
      }
      if (fresh) return null;
      const staleRecovery = `${recoveryPath}.stale-${token}`;
      try {
        renameSync(recoveryPath, staleRecovery);
        rmSync(staleRecovery, { recursive: true, force: true });
        mkdirSync(recoveryPath);
      } catch (recoverErr) {
        if (["ENOENT", "EEXIST"].includes((recoverErr as NodeJS.ErrnoException).code ?? "")) return null;
        throw recoverErr;
      }
    } else {
      throw err;
    }
  }
  try {
    const owner = readLeaseOwner(leasePath);
    let malformedLockIsFresh = false;
    if (!owner) {
      try {
        malformedLockIsFresh = Date.now() - statSync(leasePath).mtimeMs < MALFORMED_LOCK_GRACE_MS;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw statErr;
      }
    }
    if (owner ? processIsOwner(owner) : malformedLockIsFresh) return null;

    const stalePath = `${leasePath}.stale-${token}`;
    renameSync(leasePath, stalePath);
    rmSync(stalePath, { recursive: true, force: true });
    mkdirSync(leasePath);
    return finishClaim();
  } catch (err) {
    if (["ENOENT", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) return null;
    throw err;
  } finally {
    rmSync(recoveryPath, { recursive: true, force: true });
  }
}

/**
 * Read the registry, returning an empty one when the file is absent or
 * unparseable (a corrupt file must not crash a cron tick). Non-object job
 * entries are dropped defensively.
 */
export function loadRegistry(projectPath: string): Registry {
  let raw: string;
  try {
    raw = readProjectStateFile(projectPath, "schedules.json");
  } catch {
    return { jobs: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const jobs = (parsed as { jobs?: unknown })?.jobs;
    if (!Array.isArray(jobs)) return { jobs: [] };
    return { jobs: jobs.filter(isJob) };
  } catch {
    return { jobs: [] };
  }
}

/** Persist the registry, creating `.seekforge/` if needed. */
export function saveRegistry(projectPath: string, registry: Registry): void {
  writeProjectStateFile(projectPath, "schedules.json", `${JSON.stringify(registry, null, 2)}\n`);
}

/** Runtime shape guard for a stored job (tolerates hand-edited files). */
function isJob(v: unknown): v is Job {
  if (typeof v !== "object" || v === null) return false;
  const j = v as Record<string, unknown>;
  return (
    typeof j["id"] === "string" &&
    typeof j["task"] === "string" &&
    typeof j["schedule"] === "string" &&
    (j["mode"] === "ask" || j["mode"] === "edit") &&
    typeof j["maxCostUsd"] === "number" && Number.isFinite(j["maxCostUsd"]) && j["maxCostUsd"] > 0 &&
    typeof j["enabled"] === "boolean"
    && (j["failureCount"] === undefined || (Number.isSafeInteger(j["failureCount"]) && (j["failureCount"] as number) >= 0))
    && (j["nextRetryAt"] === undefined || typeof j["nextRetryAt"] === "string")
  );
}

// --- interval parsing -------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a simple interval like "30m", "2h", "1d", "45s", "1w" into milliseconds.
 * Returns null for anything that isn't a positive-integer count followed by one
 * of s/m/h/d/w (so the caller can fall through to cron parsing or reject).
 */
export function parseInterval(spec: string): number | null {
  const m = /^\s*(\d+)\s*([smhdw])\s*$/i.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const milliseconds = n * UNIT_MS[m[2]!.toLowerCase()]!;
  return Number.isSafeInteger(milliseconds) && Number.isFinite(milliseconds) ? milliseconds : null;
}

// --- cron parsing/matching --------------------------------------------------

type CronField = number[]; // sorted allowed values within the field's range

type Cron = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
  /** Whether day-of-month / day-of-week were explicitly restricted (not "*"). */
  domRestricted: boolean;
  dowRestricted: boolean;
};

const CRON_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
} as const;

/** Parse one cron field: `*`, `a`, `a-b`, ranges/wildcards with a `/step`, and `,` lists. */
function parseCronField(raw: string, [lo, hi]: readonly [number, number]): CronField | null {
  const decimal = (value: string): number | null => {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const stepSplit = part.split("/");
    if (stepSplit.length > 2) return null;
    const step = stepSplit.length === 2 ? decimal(stepSplit[1]!) : 1;
    if (step === null || step <= 0) return null;
    const rangeRaw = stepSplit[0]!;
    let start: number;
    let end: number;
    if (rangeRaw === "*") {
      start = lo;
      end = hi;
    } else if (rangeRaw.includes("-")) {
      const [a, b] = rangeRaw.split("-");
      const parsedStart = decimal(a!);
      const parsedEnd = decimal(b!);
      if (parsedStart === null || parsedEnd === null) return null;
      start = parsedStart;
      end = parsedEnd;
    } else {
      const parsed = decimal(rangeRaw);
      if (parsed === null) return null;
      start = parsed;
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < lo || end > hi || start > end) return null;
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parse a 5-field cron string; returns null if it isn't valid cron. */
export function parseCron(spec: string): Cron | null {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0]!, CRON_RANGES.minute);
  const hour = parseCronField(fields[1]!, CRON_RANGES.hour);
  const dom = parseCronField(fields[2]!, CRON_RANGES.dom);
  const month = parseCronField(fields[3]!, CRON_RANGES.month);
  // Day-of-week: parse 0..7 first, then normalize the numeric Sunday alias.
  // String replacement corrupts valid ranges/steps such as 5-7 and */7.
  const dowRaw = parseCronField(fields[4]!, [0, 7]);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = [...new Set(dowRaw.map((value) => (value === 7 ? 0 : value)))].sort((a, b) => a - b);
  const coversRange = (values: CronField, [lo, hi]: readonly [number, number]): boolean =>
    values.length === hi - lo + 1 && values.every((value, index) => value === lo + index);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: !coversRange(dom, CRON_RANGES.dom),
    dowRestricted: !coversRange(dow, CRON_RANGES.dow),
  };
}

/**
 * Whether a cron expression fires at `date` (to the minute). Uses standard cron
 * semantics: when BOTH day-of-month and day-of-week are restricted, the job
 * fires when EITHER matches; otherwise both must match.
 */
export function cronMatches(spec: string, date: Date): boolean {
  const c = parseCron(spec);
  if (!c) return false;
  if (!c.minute.includes(date.getMinutes())) return false;
  if (!c.hour.includes(date.getHours())) return false;
  if (!c.month.includes(date.getMonth() + 1)) return false;
  const domOk = c.dom.includes(date.getDate());
  const dowOk = c.dow.includes(date.getDay());
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** True when a schedule string is a valid interval OR a valid cron expression. */
export function isValidSchedule(spec: string): boolean {
  return parseInterval(spec) !== null || parseCron(spec) !== null;
}

// --- due calculation --------------------------------------------------------

/** Floor a timestamp to its minute (ms), so cron ticks fire at most once/minute. */
function floorMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * Whether `job` should run at `now`.
 * - Interval jobs: due when never run, or when `now - lastRunAt >= interval`.
 * - Cron jobs: due when the expression fires at `now` and we haven't already
 *   run during this same minute (guards repeated ticks within one minute).
 * Disabled jobs are never due.
 */
export function isDue(job: Job, now: Date): boolean {
  if (!job.enabled) return false;
  if (job.nextRetryAt) {
    const retry = Date.parse(job.nextRetryAt);
    if (!Number.isNaN(retry)) return now.getTime() >= retry;
  }
  const interval = parseInterval(job.schedule);
  if (interval !== null) {
    if (!job.lastRunAt) return true;
    const last = Date.parse(job.lastRunAt);
    if (Number.isNaN(last)) return true; // unparseable → treat as never run
    return now.getTime() - last >= interval;
  }
  if (!cronMatches(job.schedule, now)) return false;
  if (!job.lastRunAt) return true;
  const last = Date.parse(job.lastRunAt);
  if (Number.isNaN(last)) return true;
  return floorMinute(now.getTime()) !== floorMinute(last);
}

/** The enabled jobs due at `now`, in registry order. */
export function dueJobs(jobs: Job[], now: Date): Job[] {
  return jobs.filter((j) => isDue(j, now));
}

// --- validation -------------------------------------------------------------

export type ValidationResult = { ok: true; job: Job } | { ok: false; errors: string[] };

/**
 * Validate and normalize a candidate job. REQUIRED fields: id, task, a valid
 * schedule, a mode of ask|edit, and a positive finite `maxCostUsd`. A missing or
 * non-positive `maxCostUsd` is rejected — a scheduled autonomous run must be
 * cost-bounded.
 */
export function validateJobInput(input: Partial<Job>): ValidationResult {
  const errors: string[] = [];

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) errors.push("id is required");
  else if (!/^[A-Za-z0-9._-]+$/.test(id)) errors.push("id may only contain letters, digits, '.', '_' and '-'");

  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task) errors.push("task is required");

  const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
  if (!schedule) errors.push("schedule is required");
  else if (!isValidSchedule(schedule))
    errors.push(`invalid schedule "${schedule}" (use an interval like 30m/2h/1d or a 5-field cron string)`);

  const mode = input.mode;
  if (mode !== "ask" && mode !== "edit") errors.push('mode must be "ask" or "edit"');

  // The safety-critical check: a scheduled run MUST carry a cost budget.
  if (input.maxCostUsd === undefined || input.maxCostUsd === null) {
    errors.push("maxCostUsd is required (a scheduled autonomous run must be cost-bounded)");
  } else if (typeof input.maxCostUsd !== "number" || !Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0) {
    errors.push("maxCostUsd must be a positive number");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    job: {
      id,
      task,
      schedule,
      mode: mode as ScheduleMode,
      maxCostUsd: input.maxCostUsd as number,
      enabled: input.enabled ?? true,
      ...(input.lastRunAt ? { lastRunAt: input.lastRunAt } : {}),
    },
  };
}

// --- pure registry operations ----------------------------------------------

/** Slugify a task into a short id stem (first few words, lowercased). */
function slugify(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");
  return slug || "job";
}

/** Generate an id from `task` that doesn't collide with `existing`. */
export function generateId(task: string, existing: readonly Job[]): string {
  const taken = new Set(existing.map((j) => j.id));
  const stem = slugify(task);
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Add a job; throws if the id already exists (duplicate registration). */
export function addJob(jobs: Job[], job: Job): Job[] {
  if (jobs.some((j) => j.id === job.id)) throw new Error(`a job with id "${job.id}" already exists`);
  return [...jobs, job];
}

/** Remove the job with `id`; returns the new list and whether one was removed. */
export function removeJob(jobs: Job[], id: string): { jobs: Job[]; removed: boolean } {
  const next = jobs.filter((j) => j.id !== id);
  return { jobs: next, removed: next.length !== jobs.length };
}

/** Set the enabled flag on `id`; returns the new list and the updated job. */
export function setEnabled(jobs: Job[], id: string, enabled: boolean): { jobs: Job[]; job?: Job } {
  let updated: Job | undefined;
  const next = jobs.map((j) => {
    if (j.id !== id) return j;
    updated = { ...j, enabled };
    return updated;
  });
  return { jobs: next, job: updated };
}

/** Stamp `lastRunAt` on `id` (called after a tick runs a job). */
export function markRun(jobs: Job[], id: string, at: Date): Job[] {
  return jobs.map((j) => (j.id === id ? { ...j, lastRunAt: at.toISOString() } : j));
}

export const MAX_RETRY_BACKOFF_MS = 60 * 60_000;

/** Persist attempt outcome and apply exponential retry backoff after failures. */
export function markRunResult(jobs: Job[], id: string, at: Date, succeeded: boolean): Job[] {
  return jobs.map((job) => {
    if (job.id !== id) return job;
    if (succeeded) {
      const { failureCount: _failureCount, nextRetryAt: _nextRetryAt, ...rest } = job;
      return { ...rest, lastRunAt: at.toISOString() };
    }
    const failureCount = (job.failureCount ?? 0) + 1;
    const delay = Math.min(MAX_RETRY_BACKOFF_MS, 60_000 * (2 ** Math.min(failureCount - 1, 10)));
    return {
      ...job,
      lastRunAt: at.toISOString(),
      failureCount,
      nextRetryAt: new Date(at.getTime() + delay).toISOString(),
    };
  });
}

/** Next eligible tick, including a pending retry backoff. */
export function nextRunAt(job: Job, from: Date = new Date()): Date | undefined {
  if (!job.enabled) return undefined;
  const retryMs = job.nextRetryAt ? Date.parse(job.nextRetryAt) : Number.NaN;
  if (!Number.isNaN(retryMs)) return new Date(Math.max(from.getTime(), retryMs));
  const interval = parseInterval(job.schedule);
  let scheduled: number | undefined;
  if (interval !== null) {
    const last = job.lastRunAt ? Date.parse(job.lastRunAt) : Number.NaN;
    scheduled = Number.isNaN(last) ? from.getTime() : Math.max(from.getTime(), last + interval);
  } else {
    const candidate = new Date(floorMinute(from.getTime()) + 60_000);
    const limit = candidate.getTime() + 366 * 24 * 60 * 60_000;
    while (candidate.getTime() <= limit) {
      if (cronMatches(job.schedule, candidate)) {
        scheduled = candidate.getTime();
        break;
      }
      candidate.setTime(candidate.getTime() + 60_000);
    }
  }
  if (scheduled === undefined) return undefined;
  return new Date(scheduled);
}

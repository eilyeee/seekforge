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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  enabled: boolean;
};

export type Registry = { jobs: Job[] };

// --- registry paths + disk I/O ---------------------------------------------

/** Path to the project-scoped registry file (`.seekforge/schedules.json`). */
export function scheduleFilePath(projectPath: string): string {
  return join(projectPath, ".seekforge", "schedules.json");
}

/**
 * Read the registry, returning an empty one when the file is absent or
 * unparseable (a corrupt file must not crash a cron tick). Non-object job
 * entries are dropped defensively.
 */
export function loadRegistry(projectPath: string): Registry {
  let raw: string;
  try {
    raw = readFileSync(scheduleFilePath(projectPath), "utf8");
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
  const file = scheduleFilePath(projectPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
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
    typeof j["maxCostUsd"] === "number" &&
    typeof j["enabled"] === "boolean"
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
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * UNIT_MS[m[2]!.toLowerCase()]!;
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
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const stepSplit = part.split("/");
    if (stepSplit.length > 2) return null;
    const step = stepSplit.length === 2 ? Number.parseInt(stepSplit[1]!, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;
    const rangeRaw = stepSplit[0]!;
    let start: number;
    let end: number;
    if (rangeRaw === "*") {
      start = lo;
      end = hi;
    } else if (rangeRaw.includes("-")) {
      const [a, b] = rangeRaw.split("-");
      start = Number.parseInt(a!, 10);
      end = Number.parseInt(b!, 10);
    } else {
      start = Number.parseInt(rangeRaw, 10);
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
  // Day-of-week: accept 7 as an alias for Sunday (0), then normalize.
  const dowRaw = parseCronField(fields[4]!.replace(/7/g, "0"), CRON_RANGES.dow);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow: dowRaw,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
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

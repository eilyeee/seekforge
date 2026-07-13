/**
 * `seekforge schedule …` — a local, cost-bounded job scheduler (Track E).
 *
 * A job registry lives on disk at `.seekforge/schedules.json` (project-scoped).
 * `schedule run` is the TICK: it runs every DUE job (or one `--id`) via the same
 * headless run path as `seekforge -p`, enforcing each job's `maxCostUsd` budget.
 * We do NOT daemonize — the user wires `seekforge schedule run` into their OS
 * scheduler (cron / launchd / systemd timer); see docs/scheduling.md.
 *
 * SAFETY: every scheduled run is headless with a MACHINE output format, so the
 * agent's confirm callback auto-denies (no interactive prompts to hang on;
 * dangerous tools stay denied; env/execute auto-deny). Edit jobs run in
 * acceptEdits so file edits apply autonomously, while everything else is still
 * refused. Each run is a normal, auditable session (`seekforge sessions` /
 * `seekforge audit`).
 */

import { listSessions } from "@seekforge/core";
import { authorizeDir } from "../authorized-dirs.js";
import { dim, fail, green, red } from "../colors.js";
import {
  addJob,
  acquireScheduleLease,
  dueJobs,
  generateId,
  isDue,
  loadRegistry,
  markRun,
  removeJob,
  saveRegistry,
  setEnabled,
  validateJobInput,
  type Job,
  type ScheduleMode,
} from "../schedule.js";
import { runTaskCommand } from "./run.js";

export type ScheduleAddOptions = {
  task: string;
  every?: string;
  cron?: string;
  maxCost: number;
  mode?: ScheduleMode;
  id?: string;
};

/** `schedule add` — register a new job (interactive act = consent for this dir). */
export function scheduleAddCommand(opts: ScheduleAddOptions, projectPath: string = process.cwd()): void {
  const schedule = opts.every ?? opts.cron;
  if (!schedule) {
    fail("a schedule is required", { hint: "pass --every <interval> (e.g. 30m) or --cron \"<expr>\"" });
    return;
  }
  if (opts.every && opts.cron) {
    fail("pass only one of --every or --cron");
    return;
  }

  const releaseLease = acquireScheduleLease(projectPath);
  if (!releaseLease) {
    fail("another scheduler process is already running");
    return;
  }

  try {
    const registry = loadRegistry(projectPath);
    const id = opts.id?.trim() || generateId(opts.task, registry.jobs);
    const result = validateJobInput({
      id,
      task: opts.task,
      schedule,
      mode: opts.mode ?? "ask",
      maxCostUsd: opts.maxCost,
      enabled: true,
    });
    if (!result.ok) {
      fail(`invalid job:\n  - ${result.errors.join("\n  - ")}`);
      return;
    }

    let jobs: Job[];
    try {
      jobs = addJob(registry.jobs, result.job);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), { hint: "choose a different --id or remove the existing job" });
      return;
    }
    saveRegistry(projectPath, { jobs });
    authorizeDir(projectPath);

    console.log(green(`added scheduled job "${result.job.id}"`));
    console.log(dim(`  ${describeJob(result.job)}`));
    console.log(dim("  run due jobs with: seekforge schedule run  (wire this into cron/launchd — see docs/scheduling.md)"));
  } finally {
    releaseLease();
  }
}

/** `schedule list` — print all jobs (id, schedule, mode, budget, enabled, lastRun). */
export function scheduleListCommand(projectPath: string = process.cwd()): void {
  const { jobs } = loadRegistry(projectPath);
  if (jobs.length === 0) {
    console.log(dim("no scheduled jobs. Add one with: seekforge schedule add --task \"…\" --every 1d --max-cost 0.50"));
    return;
  }
  for (const job of jobs) {
    const status = job.enabled ? green("enabled") : red("disabled");
    console.log(`${job.id}  [${status}]`);
    console.log(dim(`  ${describeJob(job)}`));
    console.log(dim(`  task: ${truncate(job.task, 80)}`));
    console.log(dim(`  last run: ${job.lastRunAt ?? "never"}`));
  }
}

/** `schedule remove <id>`. */
export function scheduleRemoveCommand(id: string, projectPath: string = process.cwd()): void {
  const releaseLease = acquireScheduleLease(projectPath);
  if (!releaseLease) {
    fail("another scheduler process is already running");
    return;
  }
  try {
    const registry = loadRegistry(projectPath);
    const { jobs, removed } = removeJob(registry.jobs, id);
    if (!removed) {
      fail(`no job with id "${id}"`, { hint: "list jobs with: seekforge schedule list" });
      return;
    }
    saveRegistry(projectPath, { jobs });
    console.log(green(`removed scheduled job "${id}"`));
  } finally {
    releaseLease();
  }
}

/** `schedule enable|disable <id>`. */
export function scheduleSetEnabledCommand(id: string, enabled: boolean, projectPath: string = process.cwd()): void {
  const releaseLease = acquireScheduleLease(projectPath);
  if (!releaseLease) {
    fail("another scheduler process is already running");
    return;
  }
  try {
    const registry = loadRegistry(projectPath);
    const { jobs, job } = setEnabled(registry.jobs, id, enabled);
    if (!job) {
      fail(`no job with id "${id}"`, { hint: "list jobs with: seekforge schedule list" });
      return;
    }
    saveRegistry(projectPath, { jobs });
    console.log(green(`${enabled ? "enabled" : "disabled"} scheduled job "${id}"`));
  } finally {
    releaseLease();
  }
}

export type ScheduleRunOptions = { id?: string };

/**
 * `schedule run [--id <id>]` — the TICK. Runs every DUE enabled job (or the one
 * `--id`, forced regardless of due-time as long as it's enabled) via the
 * headless run path, enforcing each job's cost budget, then stamps lastRunAt.
 */
export async function scheduleRunCommand(opts: ScheduleRunOptions, projectPath: string = process.cwd()): Promise<void> {
  const releaseLease = acquireScheduleLease(projectPath);
  if (!releaseLease) {
    console.log(dim("another scheduler process is already running."));
    return;
  }

  try {
    // Selection must happen after lease acquisition so overlapping ticks cannot
    // both act on the same pre-run registry state.
    const registry = loadRegistry(projectPath);
    const now = new Date();

    let toRun: Job[];
    if (opts.id) {
      const job = registry.jobs.find((j) => j.id === opts.id);
      if (!job) {
        fail(`no job with id "${opts.id}"`, { hint: "list jobs with: seekforge schedule list" });
        return;
      }
      if (!job.enabled) {
        console.log(dim(`job "${job.id}" is disabled — enable it first with: seekforge schedule enable ${job.id}`));
        return;
      }
      toRun = [job];
    } else {
      toRun = dueJobs(registry.jobs, now);
    }

    if (toRun.length === 0) {
      console.log(dim("no jobs due."));
      return;
    }

    for (const job of toRun) {
      console.log(`\n▶ running scheduled job "${job.id}" (budget $${job.maxCostUsd.toFixed(2)}, mode ${job.mode})`);
      const before = new Set(listSessions(projectPath).map((s) => s.id));

      try {
        await runTaskCommand(job.task, {
          mode: job.mode,
          maxCostUsd: job.maxCostUsd,
          // Machine format → confirm auto-denies: no interactive prompt can hang a
          // headless tick, dangerous stays denied, execute/env auto-deny.
          outputFormat: "json",
          // Edit jobs must apply edits without a human; acceptEdits auto-approves
          // ONLY file edits (writes still refuse dangerous, execute/env still deny).
          ...(job.mode === "edit" ? { permissionMode: "acceptEdits" } : {}),
        });
      } catch (err) {
        console.error(red(`  job "${job.id}" errored: ${err instanceof Error ? err.message : String(err)}`));
      }

      const newSessionIds = listSessions(projectPath).map((s) => s.id).filter((id) => !before.has(id));
      console.log(
        newSessionIds.length === 1
          ? green(`  ✓ job "${job.id}" → session ${newSessionIds[0]}  (seekforge audit ${newSessionIds[0]})`)
          : newSessionIds.length === 0
            ? dim(`  job "${job.id}" produced no session`)
            : dim(`  job "${job.id}" session attribution is ambiguous (${newSessionIds.length} new sessions)`),
      );

      // Stamp lastRunAt so interval/cron due-calculation advances. Reload under
      // the lease so another scheduler's stale snapshot cannot be persisted.
      const fresh = loadRegistry(projectPath);
      saveRegistry(projectPath, { jobs: markRun(fresh.jobs, job.id, new Date()) });
    }
  } finally {
    releaseLease();
  }
}

// --- helpers ----------------------------------------------------------------

function describeJob(job: Job): string {
  const kind = /^\s*\d+\s*[smhdw]\s*$/i.test(job.schedule) ? "every" : "cron";
  const due = isDue(job, new Date()) ? " (due now)" : "";
  return `${kind} ${job.schedule} · mode ${job.mode} · max $${job.maxCostUsd.toFixed(2)}${due}`;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

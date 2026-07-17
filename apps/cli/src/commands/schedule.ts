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
import { RunManager, readRunLedger } from "@seekforge/server";
import { authorizeDir } from "../authorized-dirs.js";
import { dim, fail, green, red } from "../colors.js";
import {
  addJob,
  acquireScheduleLease,
  dueJobs,
  generateId,
  isDue,
  loadRegistry,
  markRunResult,
  nextRunAt,
  removeJob,
  saveRegistry,
  setEnabled,
  validateJobInput,
  type Job,
  type ScheduleMode,
} from "../schedule.js";
import { installScheduler, schedulerStatus, uninstallScheduler } from "../scheduler-install.js";
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
    fail("a schedule is required", { hint: 'pass --every <interval> (e.g. 30m) or --cron "<expr>"' });
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
      fail(err instanceof Error ? err.message : String(err), {
        hint: "choose a different --id or remove the existing job",
      });
      return;
    }
    saveRegistry(projectPath, { jobs });
    authorizeDir(projectPath);

    console.log(green(`added scheduled job "${result.job.id}"`));
    console.log(dim(`  ${describeJob(result.job)}`));
    console.log(
      dim("  run due jobs with: seekforge schedule run  (wire this into cron/launchd — see docs/scheduling.md)"),
    );
  } finally {
    releaseLease();
  }
}

/** `schedule list` — print all jobs (id, schedule, mode, budget, enabled, lastRun). */
export function scheduleListCommand(projectPath: string = process.cwd(), json = false): void {
  const { jobs } = loadRegistry(projectPath);
  if (json) {
    console.log(JSON.stringify(jobs));
    return;
  }
  if (jobs.length === 0) {
    console.log(dim('no scheduled jobs. Add one with: seekforge schedule add --task "…" --every 1d --max-cost 0.50'));
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

export type ScheduleRunOptions = { id?: string; dryRun?: boolean; json?: boolean };

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
      console.log(opts.json ? JSON.stringify({ due: [] }) : dim("no jobs due."));
      return;
    }

    if (opts.dryRun) {
      const output = { dryRun: true, due: toRun.map((job) => ({ id: job.id, attempt: (job.failureCount ?? 0) + 1 })) };
      console.log(opts.json ? JSON.stringify(output) : `[dry-run] would run: ${toRun.map((job) => job.id).join(", ")}`);
      return;
    }

    for (const job of toRun) {
      if (!opts.json)
        console.log(`\n▶ running scheduled job "${job.id}" (budget $${job.maxCostUsd.toFixed(2)}, mode ${job.mode})`);
      const before = new Set(listSessions(projectPath).map((s) => s.id));
      const runManager = new RunManager();
      const ledgerRun = runManager.create({
        workspace: projectPath,
        source: "schedule",
        attempt: (job.failureCount ?? 0) + 1,
        labels: { jobId: job.id },
      });
      runManager.update(projectPath, ledgerRun.runId, { status: "running" });
      let completed = false;
      let failure: string | undefined;

      try {
        completed = await runTaskCommand(job.task, {
          mode: job.mode,
          maxCostUsd: job.maxCostUsd,
          // Machine format → confirm auto-denies: no interactive prompt can hang a
          // headless tick, dangerous stays denied, execute/env auto-deny. But
          // suppress its result envelope: the scheduler owns stdout (its own
          // human lines, or one JSON object per job under --json).
          outputFormat: "json",
          suppressResult: true,
          // Edit jobs must apply edits without a human; acceptEdits auto-approves
          // ONLY file edits (writes still refuse dangerous, execute/env still deny).
          ...(job.mode === "edit" ? { permissionMode: "acceptEdits" } : {}),
        });
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        if (!opts.json) console.error(red(`  job "${job.id}" errored: ${failure}`));
      }

      const sessions = listSessions(projectPath).filter((session) => !before.has(session.id));
      const newSessionIds = sessions.map((session) => session.id);
      const session = sessions.length === 1 ? sessions[0] : undefined;
      const succeeded = completed && session?.status !== "failed" && session?.status !== "cancelled";
      runManager.update(projectPath, ledgerRun.runId, {
        status: succeeded ? "succeeded" : "failed",
        ...(session ? { sessionId: session.id, costUsd: session.usage?.costUsd ?? 0 } : {}),
        ...(!succeeded
          ? { error: { code: "schedule_failed", message: failure ?? "scheduled run did not complete" } }
          : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(runManager.get(projectPath, ledgerRun.runId)));
      } else
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
      saveRegistry(projectPath, { jobs: markRunResult(fresh.jobs, job.id, new Date(), succeeded) });
    }
  } finally {
    releaseLease();
  }
}

export function scheduleNextCommand(projectPath: string = process.cwd(), json = false): void {
  const next = loadRegistry(projectPath)
    .jobs.map((job) => ({ id: job.id, nextRunAt: nextRunAt(job)?.toISOString() }))
    .filter((entry) => entry.nextRunAt !== undefined)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  if (json) console.log(JSON.stringify(next));
  else if (next.length === 0) console.log(dim("no enabled scheduled jobs."));
  else for (const entry of next) console.log(`${entry.id}  ${entry.nextRunAt}`);
}

export function scheduleHistoryCommand(projectPath: string = process.cwd(), id?: string, json = false): void {
  const runs = readRunLedger(projectPath).filter(
    (run) => run.source === "schedule" && (id === undefined || run.labels?.["jobId"] === id),
  );
  if (json) console.log(JSON.stringify(runs));
  else if (runs.length === 0) console.log(dim("no scheduled run history."));
  else
    for (const run of runs) {
      console.log(
        `${run.runId}  ${run.status}  job=${run.labels?.["jobId"] ?? "?"}  attempt=${run.attempt}  ${run.updatedAt}`,
      );
    }
}

export function scheduleInstallCommand(
  action: "install" | "uninstall" | "status",
  opts: { dryRun?: boolean; json?: boolean },
  projectPath: string = process.cwd(),
): void {
  try {
    const result =
      action === "install"
        ? installScheduler(projectPath, opts.dryRun)
        : action === "uninstall"
          ? uninstallScheduler(projectPath, opts.dryRun)
          : schedulerStatus(projectPath);
    if (opts.json) console.log(JSON.stringify({ action, dryRun: opts.dryRun === true, ...result }));
    else
      console.log(
        `${opts.dryRun ? "[dry-run] " : ""}scheduler ${action}: ${action === "status" ? (result.installed ? "installed" : "not installed") : result.command}`,
      );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
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

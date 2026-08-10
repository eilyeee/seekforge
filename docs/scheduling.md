# Scheduled jobs

> **English** | [简体中文](scheduling.zh-CN.md)

SeekForge can run a task on a schedule — a nightly code review, a periodic
dependency check, a "summarize what changed today" digest. Scheduling is
**local-first**: there is no cloud, no daemon, and no external service. You
register jobs in the project, then use `seekforge schedule install` for an
idempotent per-project crontab tick or wire `seekforge schedule run` manually.

Every scheduled run is a **normal, auditable session** — it writes the same
JSONL trace as an interactive run, so it shows up in `seekforge sessions`, can be
replayed with `seekforge replay <id>`, reviewed with `seekforge audit <id>`, and
undone with `seekforge rewind <id>`.

## Safety first

A scheduled job runs the agent **autonomously**, with no human watching. Three
guardrails make that safe:

1. **A cost budget is mandatory.** Every job requires `--max-cost <usd>`. The run
   aborts gracefully the moment cumulative spend reaches the budget (the trace is
   kept). A job with no budget is rejected at registration time.

   The budget is only *enforceable* where SeekForge knows the model's price. On a
   custom provider with no built-in price table and no `modelPricing` in config,
   every request reports a cost of 0, so the budget can never be reached —
   `schedule add` warns about exactly this, and the fix is to set `modelPricing`.
2. **A token ceiling always applies.** Independently of price, every scheduled
   run stops once its cumulative prompt + completion tokens reach **8,000,000**
   (the same ceiling [webhook triggers](automation.md) use). This is what keeps
   the promise on *every* provider: there is no way to schedule a run with no
   ceiling at all. It is a coarse backstop, not a substitute for a working cost
   budget — and it bounds one run, not a job's lifetime: a job that keeps failing
   is bounded per tick, with the consecutive-failure auto-disable below bounding
   the repetition.
3. **Every tick is headless.** `schedule run` runs each job through the same
   engine as `seekforge -p`, but in a machine (non-interactive) mode, so the
   agent's approval callback **auto-denies** anything that would normally prompt:
   dangerous commands stay denied, and `execute`/environment actions are refused
   (there is no TTY to approve them, and a scheduled run must never hang waiting
   for input). An `edit` job runs in *acceptEdits* so ordinary file edits apply
   autonomously; everything riskier is still refused.

Registering a job also authorizes the current workspace for future ticks (the
same folder-access consent you give interactively), so the headless run isn't
blocked by the folder gate.

## The job format

Jobs live in `.seekforge/schedules.json` (project-scoped, safe to commit or to
gitignore as you prefer). Each job is:

```jsonc
{
  "jobs": [
    {
      "id": "nightly-review",        // stable id, unique within the project
      "task": "Review today's git diff and flag risky changes.",
      "schedule": "0 3 * * *",        // interval ("30m"/"2h"/"1d") OR a 5-field cron string
      "mode": "ask",                  // "ask" (read-only) | "edit" (may modify files)
      "maxCostUsd": 0.50,             // REQUIRED per-run budget (USD); must be > 0
      "enabled": true,
      "lastRunAt": "2026-07-02T03:00:00.000Z", // set by `schedule run`; absent until first run
      "failureCount": 0,                       // consecutive failures; written by `schedule run`, cleared on success
      "nextRetryAt": "2026-07-02T03:01:00.000Z" // backoff floor after a failure; absent while healthy
    }
  ]
}
```

- **`schedule`** is either a simple interval or a cron expression:
  - Interval: `<n><unit>` where unit is `s`, `m`, `h`, `d`, or `w` — e.g. `30m`,
    `2h`, `1d`, `1w`. An interval job is due when it has never run, or when at
    least the interval has elapsed since `lastRunAt`.
  - Cron: a standard 5-field expression `minute hour day-of-month month
    day-of-week` supporting `*`, lists (`1,15`), ranges (`1-5`), and steps
    (`*/15`). When both day-of-month and day-of-week are restricted, the job
    fires when *either* matches (standard cron semantics). A cron job fires at
    most once per matching minute.
- **`mode`** — `ask` for read-only Q&A/report jobs; `edit` for jobs that may
  change files (edits auto-approved; commands/dangerous actions still denied).
- **`maxCostUsd`** — required; the run stops once it reaches this (see the
  price-table caveat above).
- **`failureCount` / `nextRetryAt`** — written by `schedule run`, not by you.
  They carry the retry backoff and the auto-disable counter described below.

## Commands

```bash
# Register a job (interval)
seekforge schedule add --task "Summarize today's changes" --every 1d --max-cost 0.50

# Register a job (cron: weekdays at 09:00), allowed to edit files
seekforge schedule add \
  --task "Fix any failing tests and open a summary" \
  --cron "0 9 * * 1-5" --mode edit --max-cost 1.00 --id weekday-fix

# List jobs (id, schedule, mode, budget, enabled, last run)
seekforge schedule list

# Enable / disable a job (kept in the registry, skipped by `run` while disabled)
seekforge schedule disable weekday-fix
seekforge schedule enable  weekday-fix

# Remove a job
seekforge schedule remove weekday-fix

# THE TICK: run every DUE job now (this is what your OS scheduler invokes)
seekforge schedule run

# Force-run one specific job now, regardless of its due time
seekforge schedule run --id weekday-fix

# Inspect without running; show next ticks and append-only history
seekforge schedule run --dry-run --json
seekforge schedule next
seekforge schedule history --id weekday-fix --json

# Manage the once-per-minute project crontab block
seekforge schedule install --dry-run
seekforge schedule install
seekforge schedule status --json
seekforge schedule uninstall
```

`schedule add` flags: `--task` (required), one of `--every <interval>` /
`--cron "<expr>"`, `--max-cost <usd>` (required), `--mode ask|edit` (default
`ask`), and `--id <name>` (default: derived from the task).

Every attempt is appended to `.seekforge/runs.jsonl` with its `runId`, attempt,
status, session, cost, and error. Failures retry with exponential backoff from
one minute up to one hour; success clears the failure counter.

**After 5 consecutive failures a job is auto-disabled** (`enabled` flips to
`false` in the registry) instead of being retried again — a permanently broken
job would otherwise spend its budget every hour forever. Nothing is printed at
disable time, so a job that has quietly stopped running shows up as
`[disabled]` in `seekforge schedule list` with its `failureCount` intact;
`.seekforge/runs.jsonl` holds the failures that led there. Re-enabling it with
`seekforge schedule enable <id>` clears both `failureCount` and `nextRetryAt`,
so it starts from a clean slate.

`--json` is available on list/run/next/history/install/uninstall/status.

## Wiring the tick into your OS scheduler

SeekForge does **not** daemonize. You decide how often to *tick* — that is, how
often `seekforge schedule run` is invoked. On each tick, only jobs that are due
by their own `schedule` actually run, so ticking every minute is fine; a job set
to `1d` still runs about once a day.

### cron (Linux / macOS)

Tick every 5 minutes, from the project directory. `schedule run` must run with
the project as its working directory so it finds `.seekforge/schedules.json`:

```cron
# m h dom mon dow  command
*/5 * * * * cd /path/to/your/project && /usr/local/bin/seekforge schedule run >> .seekforge/schedule.log 2>&1
```

(Set `DEEPSEEK_API_KEY` in the crontab or a sourced profile so the agent can
authenticate.)

### launchd (macOS)

Create `~/Library/LaunchAgents/com.you.seekforge-schedule.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.seekforge-schedule</string>
  <key>WorkingDirectory</key><string>/path/to/your/project</string>
  <key>EnvironmentVariables</key>
  <dict><key>DEEPSEEK_API_KEY</key><string>sk-…</string></dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/seekforge</string>
    <string>schedule</string>
    <string>run</string>
  </array>
  <key>StartInterval</key><integer>300</integer> <!-- tick every 5 minutes -->
</dict>
</plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.you.seekforge-schedule.plist`.

### systemd timer (Linux)

`seekforge-schedule.service`:

```ini
[Service]
Type=oneshot
WorkingDirectory=/path/to/your/project
Environment=DEEPSEEK_API_KEY=sk-…
ExecStart=/usr/local/bin/seekforge schedule run
```

`seekforge-schedule.timer`:

```ini
[Timer]
OnCalendar=*:0/5   # every 5 minutes
Persistent=true

[Install]
WantedBy=timers.target
```

Then `systemctl --user enable --now seekforge-schedule.timer`.

## Reviewing scheduled runs

Because each tick produces a normal session, use the usual tools:

```bash
seekforge sessions            # scheduled runs appear here like any other
seekforge audit <session-id>  # reviewable report of exactly what the agent did
seekforge rewind <session-id> # undo a scheduled edit run's file changes
```

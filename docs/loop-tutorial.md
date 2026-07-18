# Loop Mode Tutorial (Auto-Loop)

> **English** | [简体中文](loop-tutorial.zh-CN.md)

> A hands-on tutorial for users and integrators. For the architecture and its
> invariants, read [`loop-engineering.md`](./loop-engineering.md); this page
> covers how to use loops, what happens at each step, and how to recover when
> something goes wrong.

## 1. What loop mode is

A plain `run` executes the agent once and stops. **Loop mode** adds an
orchestration layer on top:

```
run → verify → still red? run again with the failure details → verify → …
until it passes or a guardrail trips
```

In one sentence: **give it a task and a command that defines success, and the
agent keeps editing until that command exits 0.**

It fits work with an objective success criterion that needs several rounds of
trial and error:

- Turn a batch of failing tests green: `--verify "pnpm test"`
- Fix until the type check passes: `--verify "pnpm typecheck"`
- Fix until the build succeeds: `--verify "cargo build"`
- Fix until lint is clean: `--verify "pnpm lint"`

It does not fit work without an objective criterion ("make the docs nicer") —
the loop decides completion by the verify command's exit code, and without a
criterion there is no termination condition.

What it is **not**:

- Not the tool-call loop inside `loop.ts` — that is the inner loop of a single
  run. This page is about the orchestration layer *around* it
  (`packages/core/src/agent/auto-loop.ts`).
- Not Evolution (which proposes rule/skill changes for a human to accept).
  Loop mode does exactly one thing: drive one task to green.

## 2. Mental model: one task, one session, many iterations

The key design: **the whole loop is one agent session**; every iteration
resumes the previous conversation.

- Benefit: the context stays continuous, and the entire process is **one
  auditable trace** (stored under `.seekforge/sessions/<id>/`).
- The orchestration state (task, verify command, iteration count, cumulative
  cost, session id, terminal status) lives separately in
  `.seekforge/loops/<loop-id>.json` — it **points at** the session and never
  duplicates the conversation.

Three stores, each with its own job:

| Store | Path | Contents |
|---|---|---|
| Loop state | `.seekforge/loops/<id>.json` | Orchestration **snapshot**: task, verify, iterations/budget/cost, terminal status (overwritten on each step of progress) |
| Loop log | `.seekforge/loops/<id>.log` | **Append-only** JSONL history of the event stream (one timestamped event per line; resume keeps appending to the same file) |
| Session trace | `.seekforge/sessions/<id>/` | Source of truth for the agent conversation and tool calls |

> The state JSON is a snapshot (current values only); the loop log is history
> (replay what every iteration did, line by line). They complement each other.

## 3. Quick start (CLI)

The minimal form — one task plus one success-criterion command:

```bash
seekforge loop "Fix the failing parser tests without weakening assertions" --verify "pnpm test"
```

What happens:

1. In default `quick` mode, **pre-check** runs `pnpm test` once and an already
   green repository finishes without an agent iteration. With
   `--requirements analyze` or `confirm`, Loop first performs read-only
   repository analysis and freezes a structured specification; a green
   pre-check still needs an evidence-backed acceptance review.
2. Red → enter the loop: hand the task to the agent for one run
   (`acceptEdits` mode, file edits auto-approved).
3. Run `pnpm test` again, streaming its output live.
4. Still red → feed the failure into the next round's prompt
   ("`pnpm test` still fails: …, fix the root cause"), continue.
5. Until it passes, or a guardrail trips (see section 5).

Common options:

```bash
seekforge loop "<task>" --verify "<command>" \
  [--max-iters <n>]     # max iterations, default 8, hard cap 100
  [--budget <usd>]      # stop once cumulative cost reaches this
  [--requirements <quick|analyze|confirm>] # requirement and acceptance gate
  [--worktree [name]]   # run in an isolated git worktree (section 7)
  [-y]                  # only silences the "auto-approves edits" note
  [-m <model>]          # model override
```

> ⚠️ **The loop is inherently autonomous**: every run uses
> `approvalMode: "acceptEdits"` — file edits are auto-approved with no
> per-edit prompt. Dangerous commands are still refused by the denylist, and
> the workspace access consent gate (the same one `run` uses) still applies.
> In other words: it will edit your files on its own. Run it on a clean git
> state, or isolate it with `--worktree`.

`confirm` stops after analysis with `requirements_pending`. Inspect it with
`loop-show`, then run `seekforge loop-resume <id> --approve-requirements`.
The approval flag only approves that already-persisted specification; it never
silently approves requirements generated in the same invocation.

**Exit code**: 0 only when verify passed and, in analyzed modes, all required
acceptance criteria are met. Every other terminal
status is non-zero.

## 4. Inside one iteration

Following the main loop in `auto-loop.ts`, each round does, in order:

1. **Guardrail check on entry**: abort signal received → `cancelled`;
   cumulative cost reached the budget → `budget`.
2. Emit the `iteration.start` event.
3. **Build the prompt**: the original task on the first round; afterwards
   "verify still fails + structured diagnostics + output tail + fix the root
   cause".
4. **Run the agent once** (resuming the same session). Meanwhile:
   - `session.created`: capture the session id on first sight, persist it.
   - `usage.updated`: persist cumulative cost as it updates; **the moment the
     budget is reached, abort the in-flight run** (a failed run emits no
     FinalReport but its spend still counts, so the cut happens here — repeated
     expensive failures cannot silently overshoot).
5. **Increment the iteration counter, persist**, emit `run.completed` (with
   this round's cost).
6. **Verify**: run the verify command again, streaming output through
   `verify.output` events.
7. Parse diagnostics + fingerprint the workspace, persist atomically, emit
   the `verify` event.
8. **Exit code 0 + acceptance complete → `passed`, done.** Otherwise check the guardrails (next
   section) and, if none tripped, enter the next round.

> The iteration counter only advances **after** an agent run completes. If
> the process crashes mid-round, resume re-runs that round **without
> consuming** an iteration slot — while reusing the session and accounting
> for the spend already observed.

## 5. Guardrails and terminal states

The loop **never runs unbounded**. Before each round and after each
verification, these stop conditions are checked in order:

| Status | Trigger |
|---|---|
| `passed` | verify exited 0 and analyzed requirements, when enabled, passed acceptance |
| `requirements_pending` | a `confirm` specification is persisted and awaits explicit approval |
| `cancelled` | abort signal (Ctrl-C / Stop button); cooperative stop, trace preserved |
| `budget` | cumulative observed cost ≥ `--budget` (an in-flight request may make the final bill slightly exceed it) |
| `no_progress` | **stuck**: structured diagnostics fingerprint unchanged **and** workspace content fingerprint unchanged |
| `exhausted` | reached the `--max-iters` cap |
| `verify_error` | verify command could not run at all / timed out / failed at the executor boundary |

Check order (before spending another round): `aborted` → `budget` →
`no_progress` (diagnostics and workspace both unchanged) → `exhausted`.

`no_progress` is the core anti-livelock mechanism: raw diagnostic text is
easily fooled by timing and formatting noise, so the loop pairs the
**structured diagnostics fingerprint** with a **workspace content
fingerprint**. If the agent changed any file — even without fixing the
tests — that still counts as progress and the loop keeps going; only when
both diagnostics and files are byte-identical is it declared stuck.

## 6. Verification and diagnostics parsing

The verify command runs in the workspace through the project's shared shell
executor + OS sandbox, with a **120-second timeout**, capturing a tail
(~4 KB) of stdout+stderr. Cancelling during verification stops the command
and returns `cancelled`.

On failure the output is fed into the next round's prompt, and mainstream
test frameworks get **structured parsing** (`verify-diagnostics.ts`):

- **Vitest / Jest / Pytest / Cargo** are auto-detected.
- Failed test names (deduplicated, bounded) and diagnostic locations
  (`file:line: message`) are extracted.
- Timing/format/ANSI noise is stripped, leaving stable "failure identities"
  used for the convergence fingerprint (the `no_progress` decision).
- Unknown frameworks degrade to the raw output tail.

**Workspace fingerprint**: in a git repository, the full content of changed,
staged, and untracked files is hashed; a non-git workspace hashes all files.
SeekForge's own runtime state (`.seekforge/loops|sessions|uploads`) is
excluded. Symbolic links are hashed as links and never followed outside the
workspace.

## 7. Isolated runs: `--worktree`

Don't want the loop editing your current working directory? Use a worktree:

```bash
seekforge loop "<task>" --verify "pnpm test" --worktree            # auto-named
seekforge loop "<task>" --verify "pnpm test" --worktree my-fix     # branch suffix
```

The CLI creates a branch (prefixed `seekforge/loop-*`) with a matching git
worktree and uses that directory as the loop's workspace. Loop state and the
session trace both live inside the worktree.

Key points:

- **Worktrees are never removed automatically** — deliberately retained for
  inspection.
- Run `loop-resume` from inside the worktree directory to continue.
- Clean up with `seekforge loop-cleanup <name>` when done; dirty worktrees
  are refused unless `--force` is explicit.
- While a live lease exists (the loop is running), cleanup is always
  refused — even with `--force`.

## 8. Resume

Any terminal loop can be explicitly resumed — and resume starts with a
**fresh pre-check**, which may pass outright:

```bash
seekforge loop-resume <loop-id> [--approve-requirements] [--add-iters <n>] [--add-budget <usd>]
```

- Resume loads state only from the workspace you give it, preserving the
  original task, verify command, max iterations, cumulative cost, and
  session id.
- A terminal loop whose iterations/budget are already exhausted can **only
  pass via the pre-check** — otherwise the same guardrail stops it again
  without wasting agent iterations.
- `--add-iters`: added to the stored maximum, hard-capped at 100.
- `--add-budget`: extends the stored budget; with no prior budget it starts
  from the cost already incurred, so historical spend is never reset. The
  resulting budget must be finite — numeric overflow is rejected rather
  than treated as "no limit".

Management commands:

```bash
seekforge loop-list                    # list all persisted loops
seekforge loop-show <loop-id>          # inspect one loop's state
seekforge loop-delete <loop-id>        # delete persisted state
seekforge loop-cleanup <name> [--force] # remove a worktree
```

Run from the base checkout, these commands also discover loop state inside
retained worktrees. A loop id appearing in multiple workspaces is rejected
as **ambiguous** instead of picking one silently. Management works outside
git repositories too; paths stored by older versions are canonicalized to
their physical form so symlink and platform path aliases resolve to the
same state.

## 9. Crash recovery, locking, and persistence (internals)

You never manage this by hand, but knowing it helps with debugging:

- **Atomic writes**: state is persisted after observable progress via
  write-temp-then-rename, so a crash never leaves a half-written state file.
- **Exclusive lease**: one process owns a persisted loop at a time. A
  token-protected lock next to the state file records the owner's process
  identity and PID, rejects concurrent runs, and recovers locks after
  process exit or PID reuse. A freshly malformed lock fails closed for a
  short grace period so a partially written lock cannot be stolen.
- **Persistence failure degrades gracefully**: a failed write is reported
  once as `loop.warning` and never replaces the verification result.
- **Cost and session checkpoint as events arrive**: the session id and
  cumulative usage are persisted the moment their events land, so a resume
  after a crash reuses the session and accounts for spend already observed.
- **Append-only event log**: every `LoopEvent` (iteration start, run cost,
  streamed verify output, pass/fail, summary) is appended as JSONL to
  `.seekforge/loops/<id>.log`. This is **best-effort observability**: a
  failed log write is swallowed and never interrupts the loop (a genuinely
  broken directory still surfaces through the persistence warning above).
  With `persist: false` no log is written; `loop-delete` removes it together
  with the state. The log lives under the `.seekforge/loops/` prefix, which
  is excluded from the workspace fingerprint, so it cannot disturb the
  `no_progress` decision.

Reading the log:

```bash
tail -f .seekforge/loops/<loop-id>.log        # follow a running loop live
cat .seekforge/loops/<loop-id>.log | jq .      # structured replay (one event per line)
```

The CLI also prints this log's path in every end-of-loop summary.

## 10. Desktop / TUI usage

**Desktop**: a collapsible **Loop panel** at the top of the chat window —
task + verify-command inputs, max-iterations + budget, and a Run/Stop
button. Progress streams live (one row per iteration: run cost + live
verify output + pass/fail; a status summary and loop id at the end). The
toolbar's model/thinking overrides ride along, same as a normal run. If the
connection drops, the run is marked interrupted, pending prompts are
cleared, and requests queued for the failed connection are discarded rather
than replayed on reconnect.

**TUI**: `/loop` takes a multi-line command — loop options and the verify
command on the first line, the task on the following lines:

```text
/loop --requirements analyze --max-iterations 12 --budget 1.50 pnpm test
Fix the failing parser tests without weakening assertions.
```

`--requirements` accepts `quick|analyze|confirm`; `--max-iterations` accepts
1–100; `--budget` must be a finite positive USD
value and overrides the configured default. Without an explicit budget the
TUI inherits the configured value. The default iteration cap is 8. Resume
from the TUI with `/loop-resume [--approve-requirements] [--add-iterations N] [--add-budget USD]
<loop-id>`.

## 11. Core API (integrators)

Import `runAutoLoop` / `resumeAutoLoop` from `@seekforge/core`:

```ts
import { runAutoLoop } from "@seekforge/core";

const result = await runAutoLoop(deps, {
  task: "Fix the failing tests",
  workspace: "/abs/path/to/project",   // must be absolute
  verifyCommand: "pnpm test",           // exit 0 == success
  maxIterations: 8,                     // default 8, hard cap 100
  costBudgetUsd: 2.0,                   // stop at cumulative observed cost (optional)
  approvalMode: "acceptEdits",          // the default
  signal: controller.signal,            // cooperative abort (optional)
  onEvent: (e) => { /* iteration.start | run.completed | verify.output | verify | loop.warning | loop.done */ },
  // verify: injectable custom verifier (for tests); defaults to a real shell exec + sandbox
});

// result.status also includes "requirements_pending" for confirm mode
// result.iterations / result.costUsd / result.sessionId / result.finalVerify / result.loopId
```

Event stream types (`LoopEvent`):

- `iteration.start` — round n begins
- `run.completed` — round n's agent run finished, with cumulative cost
- `verify.output` — streamed verify output chunk (per-verification event
  count and chunk size are capped)
- `verify` — verification result (exit code + passed + output tail)
- `loop.warning` — currently only the persistence-failure warning
- `loop.done` — the final `LoopResult`

`resumeAutoLoop(deps, loopId, { workspace, additionalIterations?,
additionalCostBudgetUsd? })` restores iterations, cost, session, command,
and guardrails, then applies the optional additive limits.

## 12. Practical advice and FAQ

**How do I pick a verify command?** Fast and deterministic. It runs every
round — a slow command drags the whole loop and risks the 120-second
timeout. Run the relevant subset instead of the full suite when you can
(e.g. only the test files your change touches).

**Why did it stop with `no_progress` after a few rounds?** Two consecutive
rounds produced neither different diagnostics nor any file change — declared
stuck. Usually the task description is too vague, or the root cause exceeds
the agent's ability. Sharpen the task, or resume with a stronger model
(`-m`).

**Why `verify_error`?** The verify command never ran — misspelled command,
missing dependency, timeout. The terminal output carries stdout/stderr
diagnostics; follow those.

**Will it burn a lot of money?** It can. Always set `--budget`. The budget
is a hard line checked on every usage update, cutting the in-flight request
when reached; the one request already sent may make the final bill slightly
exceed it.

**How do I stop it mid-run?** Ctrl-C (CLI) or the Stop button (desktop).
Cooperative stop, status `cancelled`, trace preserved — `loop-resume` works
afterwards. A second Ctrl-C force-exits.

**It made a mess — now what?** It is a plain git workspace: `git restore` /
`git checkout` rolls it back. That is exactly why `--worktree` isolation, or
a clean git state, is recommended.

**How does it relate to a normal run/session?** The loop reuses `runTask` +
session resume and the same permission model; verification reuses
`run_command`'s shell executor and OS sandbox; it also reuses
`escalateOnFailure` (hand failing runs to `planModel`). The whole loop is
**one session**, so session-level `resume` / `rewind` remain available for
manual intervention at any time.

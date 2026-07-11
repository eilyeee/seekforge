# Loop engineering (auto-loop)

Drive **one** task to "green" across multiple agent runs, fully autonomously:
`run → verify → continue`, stopping when a verification command passes or a
budget guardrail trips. This is a layer *above* a single run — the in-run
tool loop (`packages/core/src/agent/loop.ts`) is unchanged.

```
goal + verifyCmd ──▶ runTask ──▶ run verifyCmd
                        ▲             │ exit 0? ──▶ passed ✅
                        │             │ else
                        └── continue (failure output) ◀── guardrails ok?
                                                           └ no ──▶ stop (reason)
```

## CLI

```
seekforge loop "<task>" --verify "<cmd>" [--max-iters <n>] [--budget <usd>] [-y] [-m <model>]
```

- `--verify <cmd>` (required): success = the command exits 0.
- `--max-iters <n>`: cap on run iterations (default 8).
- `--budget <usd>`: observed cumulative-cost stopping line across iterations.
  Usage is checked after each provider usage update and prevents further work,
  but an already in-flight request can make the final billed amount slightly
  exceed the configured value.
- The loop is inherently autonomous — every run uses `approvalMode: "acceptEdits"`
  (file edits auto-approved; dangerous commands still refused by the denylist).
  `-y` just silences the "auto-approves edits" note.
- `Ctrl-C` stops cooperatively (status `cancelled`); the session trace is kept,
  so `seekforge resume <id>` / `seekforge rewind <id>` still work.
- Exit code 0 only when the verify command passed.

The whole loop is **one session** (each iteration resumes it), so it is a single
auditable trace.

## Core API

`runAutoLoop(deps, opts)` from `@seekforge/core`:

```ts
type LoopOptions = {
  task: string;
  workspace: string;
  verifyCommand: string;        // exit 0 = done
  maxIterations?: number;       // default 8
  costBudgetUsd?: number;       // stop after observed cumulative usage reaches it
  approvalMode?: ApprovalMode;  // default "acceptEdits"
  model?: string; planModel?: string; escalateOnFailure?: boolean;
  signal?: AbortSignal;         // cooperative stop
  onEvent?: (e: LoopEvent) => void;
  verify?: (workspace, command) => Promise<{ code; output }>; // test seam
};
type LoopResult = {
  status: "passed" | "exhausted" | "no_progress" | "budget" | "cancelled" | "verify_error";
  iterations: number; costUsd: number; sessionId: string;
  finalVerify: { code: number; output: string };
};
```

## Guardrails (all on by default)

Checked before spending another iteration, in order:

1. `signal.aborted` → `cancelled`
2. observed cumulative cost ≥ `costBudgetUsd` → cancel the active run and return
   `budget` after verification
3. verify output byte-identical to the previous iteration **and** the latest
   agent run changed no files → `no_progress` (stuck)
4. reached `maxIterations` → `exhausted`

A `verify_error` is returned when the verify command can't be run at all.

## Verification

`opts.verify` is injectable (used by tests). The default executes the command in
the workspace through the shared shell executor and configured OS sandbox, with
a 120 s timeout and a cooperative abort signal, and captures a ~4 KB tail of
stdout+stderr. Cancelling during verification stops the command and returns
`cancelled`. On failure the output tail is fed back into the next run's prompt
("`<verifyCommand>` still fails: …, fix the root cause").

## Desktop

A collapsible **Loop panel** at the top of the chat window (`LoopPanel`):
explanation line, task + verify-command inputs, max-iterations + budget, and a
Run/Stop button. Progress streams live (one row per iteration: run cost + verify
pass/fail + output tail; a status summary on `loop.done`).

Wire: a `loop` WS client frame `{type:"loop", task, verifyCommand, maxIterations?,
budget?, ws?, model?, thinking?, reasoningEffort?}` — the model/thinking
overrides from the run-toolbar ride along, same as a normal run. The server runs
`runAutoLoop` (acceptEdits) and streams `{type:"loop.event", event}` back, ending
with `idle`. `cancel` stops it. Permission/question prompts during the loop's
runs use the existing modals.

## TUI

`/loop` uses a multi-line command: the first line contains loop options and the
verification command; following lines are the task.

```text
/loop --max-iterations 12 --budget 1.50 pnpm test
Fix the failing parser tests without weakening assertions.
```

Both options are optional. `--max-iterations` accepts `1-100`; `--budget` must
be a finite positive USD value and overrides `costBudgetUsd` from config. Without
an explicit budget, the TUI inherits the configured value. The default iteration
limit is 8.

## Relation to existing features

Reuses `runTask` + session resume and the agent permission model; verification
uses the same shell executor and OS sandbox as `run_command`. It also reuses
`escalateOnFailure` (hand failing runs to `planModel`). Distinct from **Evolution**
(which proposes rule/skill changes for a human to accept) — auto-loop just drives
one task to green. Surfaced in CLI, desktop, and TUI (`/loop`).

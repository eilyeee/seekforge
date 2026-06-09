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
- `--budget <usd>`: cumulative cost cap across iterations.
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
  costBudgetUsd?: number;       // hard cap across iterations
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
2. cumulative cost ≥ `costBudgetUsd` → `budget`
3. verify output byte-identical to the previous iteration → `no_progress` (stuck)
4. reached `maxIterations` → `exhausted`

A `verify_error` is returned when the verify command can't be run at all.

## Verification

`opts.verify` is injectable (used by tests). The default runs the command via
`/bin/sh -c` in the workspace with `LC_ALL=C`, a 120 s timeout, and captures a
~4 KB tail of stdout+stderr. On failure that tail is fed back into the next run's
prompt ("`<verifyCommand>` still fails: …, fix the root cause").

## Relation to existing features

Reuses `runTask` + session resume, the sandbox/permission model, and
`escalateOnFailure` (hand failing runs to `planModel`). Distinct from **Evolution**
(which proposes rule/skill changes for a human to accept) — auto-loop just drives
one task to green. Not yet surfaced in the TUI/desktop (CLI + core first).

# Evals & the regression gate

Two layers protect against regressions:

1. **Deterministic CI gate** (`.github/workflows/ci.yml`, runs on every push/PR):
   `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test`, plus `cargo check`/`test`
   (the desktop shell crate is excluded — it needs a built frontend). This covers
   all unit/contract/security tests; it needs no API key and is the everyday net.
2. **Eval gate** (`.github/workflows/eval.yml`, manual) — runs the agent against
   real tasks via the DeepSeek API and fails on a regression vs the baseline.
   Because it costs money and is non-deterministic, it is **not** on the PR gate.

## Running evals locally

```sh
# Needs a key; without one the harness prints a skip and exits 0.
export DEEPSEEK_API_KEY=sk-...
pnpm --filter @seekforge/eval-harness eval                          # full task set
pnpm --filter @seekforge/eval-harness eval -- --task add-function   # one task
pnpm --filter @seekforge/eval-harness eval -- --task a,b,c          # a subset (comma list)
```

Useful flags (see `src/cli.ts`): `--task <id|id,id,...>` (one id or a
comma-separated subset), `--baseline <file>`, `--fail-on-regression`,
`--variant <name>`, `--ab <a,b>`, `--skill-ranking`, `--keep`, `--list-variants`.
Each run writes a timestamped `.md` + `.json` under `evals/reports/`.

### Variants (for `--variant` / `--ab`)

`--list-variants` prints the registry. Current variants (see `src/variants.ts`):
`control` (baseline), `terse-prompt`, `llm-compaction`, `no-memory`,
**`verify-gate`** (enables the self-verification finalize gate, `verifyCommand=npm test`),
**`no-auto-verify`** (verify-gate but nudge-only), **`no-retrieval`** (disables the
task-relevant shortlist), **`review-gate`** (enables `finalizeReview`),
**`model-pro`** (runs under `deepseek-v4-pro`), **`no-progress-guard`** (enables
the premature-finish guard), **`context-tight`** (shrinks the context window to
`32000` tokens to force earlier compaction), and **`verify-and-review`** (stacks
self-verify `npm test` + auto-run + final diff self-review). A/B a lever against
`control`, e.g. `--ab control,verify-gate`.

> Honest note: A/B runs of `verify-gate` showed **no pass-rate gain and ~+10% cost**
> on the current (verify-prompted) task set — which is why that lever ships opt-in,
> not on by default.

### Capability experiments

Two zero-core-change capability A/Bs you can run in **one command** each once
`DEEPSEEK_API_KEY` is set (no key ⇒ the run skips and exits 0). Each runs the full
task set under `control` and the variant, then prints the `toAbMarkdown` table
(per-task ✓/score/turns/cost, plus Win/Loss/Tie, cost Δ, and cost-per-success) and
writes `evals/reports/ab-<ts>.json`.

```sh
# Does a tighter context window (earlier/more compaction) save tokens without hurting completion?
pnpm --filter @seekforge/eval-harness eval -- --ab control,context-tight

# Do self-verify (npm test, auto-run) + a final diff self-review raise completion, and at what cost?
pnpm --filter @seekforge/eval-harness eval -- --ab control,verify-and-review
```

- **`context-tight`** measures the token/cost effect of forcing compaction sooner
  (window `32000`). The win case is **lower cost at equal-or-better completion**;
  the risk is compaction dropping context the agent still needed.
- **`verify-and-review`** measures whether stacking both quality gates raises the
  **completion rate**, and prices the extra turns/tokens the gates cost.

**How to read the result and decide:**
- **Win/Loss/Tie** counts tasks where the variant did better / worse / same on
  the pass-and-score. More Wins than Losses ⇒ the change helps completion; more
  Losses ⇒ it hurts (for `context-tight`, Losses usually mean over-eager
  compaction).
- **cost-per-success** is total cost ÷ tasks passed — the bottom line. Keep the
  change only if cost-per-success **drops** (or holds while Wins > Losses). If
  completion is flat and cost-per-success rises (as `verify-gate` did solo), the
  lever stays opt-in, not default.

### Round-52 capability measurements

[`evals/round-52-measurements.md`](../evals/round-52-measurements.md) records the
real-run A/B of the round-52 levers and the runbook to reproduce them. Summary:
**auto-verify** is positive (fewer turns, ~30% cheaper → default on); **retrieval**
shows no gain on greppable tasks but wins 3/3 reps on a deliberately grep-noisy
ask task (→ default on, value concentrated on hard navigation); **review-gate**
adds cost with no measured benefit, even on a fixture built to need it (→ opt-in).
The discriminating fixtures are `cjk-find-checkout` (retrieval) and
`cjk-review-edge` (review); `cjk-large-paginate` (159 files) is the only fixture
large enough to trigger the retrieval (≥40) **and** repo-overview (≥150) floors.

## The baseline

`evals/baseline.json` is a committed report (`{ generatedAt, results }`) from a
**real** run — never hand-edited or fabricated. To refresh it after an
intentional, reviewed change in behavior:

```sh
pnpm --filter @seekforge/eval-harness eval        # produces evals/reports/<ts>.json
cp evals/reports/<ts>.json evals/baseline.json    # commit with a note on what changed
```

## The regression gate

```sh
pnpm --filter @seekforge/eval-harness eval -- --baseline evals/baseline.json --fail-on-regression
```

`--fail-on-regression` exits non-zero **only** when a task the baseline recorded
as a success now fails (a pass→fail). Newly-added tasks, removed tasks, and
tasks already red in the baseline never trip the gate — so a known-flaky case
doesn't block, but a genuine behavior regression does. (Without the flag, any
absolute failure exits non-zero — the convenient default for local runs.)

## Importing an external benchmark

You can pull a SWE-bench-style task (a repo snapshot + an instruction + a pass
condition) into this harness so it runs through the **same** deterministic gate
as the native tasks. Nothing about the benchmark format leaks in: you translate
it into our task + fixture shape and the harness treats it like any other task.

### The native shapes

A task is a JSON file at `evals/tasks/<id>.json`:

```json
{
  "id": "string id, must match the filename and be registered (see below)",
  "title": "human-readable one-liner",
  "fixture": "name of a dir under evals/fixtures/",
  "mode": "edit",
  "task": "the natural-language prompt handed to the agent",
  "checks": [ /* one or more checks, ALL must pass */ ]
}
```

A fixture is a **self-contained project** at `evals/fixtures/<name>/`. It must
be hermetic: only Node built-ins, no `dependencies`/`devDependencies` in its
`package.json` (the dataset gate enforces this). The harness copies it to a
throwaway dir, `git init`s it, then runs the agent there.

Checks (see `packages/eval-harness/src/task-runner.ts`) are deterministic — no
LLM judges:

- `file_contains` — `{ type, path, pattern }`: regex must match the file.
- `file_not_contains` — same shape: regex must **not** match (pins what the
  agent may not do, e.g. editing the test file).
- `command_succeeds` — `{ type, command, cwd? }`: shell command must exit 0.
- `answer_matches` — `{ type, pattern }`: regex must match the agent's final
  summary.

### The mapping

| External benchmark concept        | This harness                                   |
| --------------------------------- | ---------------------------------------------- |
| Task instruction / problem text   | task `prompt` (the `task` field)               |
| Repo snapshot at the base commit  | a fixture dir under `evals/fixtures/<name>/`   |
| Pass condition (e.g. test passes) | a `command_succeeds` check running that test   |
| "Don't touch the tests" guard     | optional `file_not_contains` on the test file  |
| Task id                           | the JSON filename + a registration (see below) |

The benchmark's gold patch is **discarded** — the agent is supposed to produce
its own fix; the `command_succeeds` check (running the benchmark's
fail-to-pass test) is what decides pass/fail.

### Worked example

Say an external benchmark gives you a tiny Node project whose `sum()` is buggy
and a test `test/sum.test.js` that currently fails, and the pass condition is
"`npm test` exits 0 without editing the tests".

1. **Snapshot → fixture.** Copy the repo's base-commit tree into
   `evals/fixtures/ext-sum-bug/`, stripping anything non-hermetic. Give it a
   `package.json` with a `test` script and no dependencies:

   ```json
   { "name": "ext-sum-bug-fixture", "private": true,
     "scripts": { "test": "node --test" } }
   ```

   Keep the failing `test/sum.test.js` and the buggy `src/sum.js`.

2. **Instruction → prompt + checks.** Create `evals/tasks/ext-sum-bug.json`:

   ```json
   {
     "id": "ext-sum-bug",
     "title": "Imported: fix sum() so the suite passes",
     "fixture": "ext-sum-bug",
     "mode": "edit",
     "task": "`npm test` fails in this project. Fix the implementation so all tests pass. Do NOT modify anything under test/. Run the tests to verify.",
     "checks": [
       { "type": "command_succeeds", "command": "npm test" },
       { "type": "file_not_contains", "path": "test/sum.test.js", "pattern": "TODO" }
     ]
   }
   ```

   The `command_succeeds` check *is* the benchmark's fail-to-pass condition; the
   `file_not_contains` guard keeps the agent from "passing" by editing the test.

3. **Register the id.** Add `"ext-sum-bug"` to the expected-ids array in
   `packages/eval-harness/tests/dataset.test.ts` (keep the list sorted) and bump
   the count in its `it("contains the … expected tasks")` title. The dataset gate
   will then verify the fixture exists, is hermetic, and that every check pattern
   compiles.

After that the task runs exactly like a native one
(`pnpm --filter @seekforge/eval-harness eval -- --task ext-sum-bug`).

## Failure-sample archive

When real-world dogfooding hits a genuine miss — the agent botches something it
should have handled — capture it here instead of letting it evaporate. Minimize
the failure into a **hermetic fixture** in the exact format above (only Node
built-ins, a failing `node --test` that encodes the pass condition, plus a
`file_not_contains` guard so the agent can't "pass" by editing the test), then
register the id in `packages/eval-harness/tests/dataset.test.ts`.

Two things make this safe to do eagerly:

- **A brand-new task never trips `--fail-on-regression`.** The gate only fires on
  a baseline pass→fail; a task absent from the baseline (or already red in it) is
  ignored. So you can commit a fixture that captures a capability we don't have
  yet and leave it **red** — it documents the gap without blocking anyone.
- The fixture stays red until the capability actually lands. Once a real run
  turns it green and you refresh `evals/baseline.json`, it becomes a protected
  case like any other: from then on a regression on it *does* trip the gate.

The point is to grow the set from observed reality, not just imagined tasks — a
minimized repro of a real miss is worth more than a synthetic one. Keep each
fixture as small as the bug allows.

## CI

The eval workflow is `workflow_dispatch` (run it from the Actions tab) and reads
`DEEPSEEK_API_KEY` from repo secrets; it runs the set with
`--baseline evals/baseline.json --fail-on-regression` and uploads the report.
Add a `schedule:` cron in `eval.yml` if you want it to run periodically. Adding
new scenarios? Drop a task + fixture under `evals/` and register the id in
`packages/eval-harness/tests/dataset.test.ts` (the deterministic gate enforces
fixtures exist).

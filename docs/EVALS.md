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
pnpm --filter @seekforge/eval-harness eval                       # full task set
pnpm --filter @seekforge/eval-harness eval -- --task add-function  # one task
```

Useful flags (see `src/cli.ts`): `--task <id>`, `--baseline <file>`,
`--fail-on-regression`, `--variant <name>`, `--ab <a,b>`, `--skill-ranking`,
`--keep`, `--list-variants`. Each run writes a timestamped `.md` + `.json` under
`evals/reports/`.

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

## CI

The eval workflow is `workflow_dispatch` (run it from the Actions tab) and reads
`DEEPSEEK_API_KEY` from repo secrets; it runs the set with
`--baseline evals/baseline.json --fail-on-regression` and uploads the report.
Add a `schedule:` cron in `eval.yml` if you want it to run periodically. Adding
new scenarios? Drop a task + fixture under `evals/` and register the id in
`packages/eval-harness/tests/dataset.test.ts` (the deterministic gate enforces
fixtures exist).

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

## CI

The eval workflow is `workflow_dispatch` (run it from the Actions tab) and reads
`DEEPSEEK_API_KEY` from repo secrets; it runs the set with
`--baseline evals/baseline.json --fail-on-regression` and uploads the report.
Add a `schedule:` cron in `eval.yml` if you want it to run periodically. Adding
new scenarios? Drop a task + fixture under `evals/` and register the id in
`packages/eval-harness/tests/dataset.test.ts` (the deterministic gate enforces
fixtures exist).

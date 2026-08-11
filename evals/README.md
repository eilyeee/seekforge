# SeekForge evals

Dataset for the eval harness in `packages/eval-harness`. Each task in
`tasks/*.json` points at a self-contained fixture in `fixtures/<name>/`;
the harness copies the fixture into a throwaway git workspace, runs the
agent, then grades with deterministic checks only (no LLM judges).

## Task format

```jsonc
{
  "id": "kebab-case-id",          // unique; file should be <id>.json
  "title": "Human-readable title",
  "fixture": "fixtures/<name> directory",
  "mode": "edit",                  // or "ask"
  "runner": "agent",               // optional: agent | loop | session_scenario | graph
  "task": "The prompt given to the agent.",
  "checks": [ /* see below */ ],
  "notes": "optional rationale"
}
```

Supported checks (see `packages/eval-harness/src/tasks.ts`):

- `file_contains` / `file_not_contains` — regex against a workspace file
- `command_succeeds` — shell command exit code 0 (optional `cwd`)
- `answer_matches` — regex against the agent's final answer (ask mode)
- `memory_stats` — exact/tolerant comparison against a final memoryStats field
- `memory_fact_activity` — exact uses/exposures/retrievals count for one fact

Omitting `runner` preserves the original one-session agent run. `loop` tasks
provide `loop.verifyCommand`, `loop.maxIterations`, and `loop.expectedStatus`,
with optional persisted resume settings. `session_scenario` tasks run ordered
agent and memory lifecycle steps; an agent step with `resume: true` resumes the
previous session rather than starting a new trace.

### `graph` tasks (Engineering Graph control plane)

A `graph` task carries a complete Engineering Graph definition inline and drives
core's real `runEngineeringGraph` with the same deterministic `noop`/`collect`
handler registry the CLI and Server expose — the harness never invents a handler
that could run a shell command:

```jsonc
{
  "runner": "graph",
  "mode": "edit",
  "graph": {
    "expectedStatus": "passed",     // terminal GraphRunStatus of the LAST invocation
    "approve": ["release-review"],  // gate node paths pre-approved on the first invocation
    "costBudgetUsd": 1,             // optional operational caps (also "tokenBudget")
    "definition": { "graphId": "…", "nodes": [ /* … */ ] },
    "resume": {                     // optional second invocation against the checkpoint
      "expectedInitialStatus": "paused",           // asserted BEFORE resuming
      "approve": ["review"],                       // --approve
      "rerun": ["package"],                        // --rerun (node + descendants)
      "signals": [{ "name": "artifact-ready", "payload": { "release": "1.2.3" } }]
    }
  }
}
```

`definition` is parsed by core's `parseEngineeringGraphDefinition`, and the
approve/rerun selections go through `validateEngineeringGraphRunOptions`, so an
unknown gate, an undeclared rerun target, or an unregistered handler fails the
dataset gate rather than a paid run. Signals are enqueued into
`.seekforge/graphs/<graphId>.signals.json` between the two invocations, which is
exactly how an external system wakes a `wait` node.

The task's `answer_matches` checks grade a deterministic status line —
`graph <graphId> <status> <node>=<status> …` — not model prose, because a Graph
has no single final summary.

Graph fixtures ship a `verify-graph.mjs` that reads the durable checkpoint at
`.seekforge/graphs/<graphId>.json` and asserts node kinds/statuses/attempts,
lifecycle event counts, and dependency ordering. That is what makes the *control
plane* graded rather than only the file the Agent node happened to edit.

Current graph tasks:

| Task | Graph behavior under test |
| --- | --- |
| `graph-multi-node` | five-node dependency graph (agent + function + gate + join) reaching `passed`, gate crossed by an explicit approval on the first invocation |
| `graph-gate-approval` | graph pauses at a gate (`paused`, `pauseReason: approval`), resume with `--approve` crosses it without replaying the Agent ancestor |
| `graph-rerun-descendants` | resume with `--rerun` invalidates one node plus its descendants while every ancestor keeps its settled result |
| `graph-wait-signal` | `wait` node parks the graph durably; an external signal wakes it, its payload lands in the node output, and the mailbox is drained |
| `graph-failure-continue` | `failurePolicy: "continue"` — an expired wait fails, its dependent is skipped, the independent Agent branch still completes, run is `failed` |

## Fixture conventions

- Tiny (a handful of files), with zero third-party dependencies. Most use
  `node --test`; Python, Go, and Rust fixtures use their standard toolchains.
  `package.json` must not declare `dependencies` or `devDependencies`
  (enforced by `tests/dataset.test.ts`).
- One exception: `ts-typing-fix` typechecks through a version-pinned
  `npx --yes --package typescript@5.7.3 tsc`, which npx caches after the
  first run, so the fixture itself still installs nothing.
- Pin tests against reward hacking: when a task says "don't touch the
  tests", add `file_contains`/`file_not_contains` checks on the test file
  so a rewritten assertion fails the task.

## Running

```bash
pnpm --filter @seekforge/eval-harness test   # harness + dataset tests (offline)
pnpm --filter @seekforge/eval-harness eval   # real run; needs DEEPSEEK_API_KEY
pnpm --filter @seekforge/eval-harness eval -- --task <id> --baseline evals/baseline.json
pnpm --filter @seekforge/eval-harness eval -- --suite smoke
pnpm --filter @seekforge/eval-harness eval -- --suite nightly --junit evals/reports/junit.xml
```

## Continuous suites

`config.json` defines three strictly validated suites:

| Suite | Tasks | Default samples | Intended use |
| --- | ---: | ---: | --- |
| `smoke` | 15 representative tasks | 1 | quick model/config and Loop lifecycle check |
| `nightly` | all 68 tasks | 3 | weekly regression and efficiency gate |
| `release` | all 68 tasks | 5 | release qualification with tighter gates |

`smoke` is an explicit id list, so the five `graph-*` tasks currently run only in
`nightly`/`release` (both select `"*"`). Adding one of them to `smoke` is a
`config.json` edit.

Use `--repeat <n>` (1 to 20) to override the sample count and `--task a,b` to narrow the
chosen suite. `--require-api-key` turns a missing provider key into a non-zero
infrastructure failure; without it, local runs retain the historical skip.

Each result sample includes prompt/completion/cache-hit/total tokens, cost,
duration, tool failures, and session errors. JSON reports add run metadata,
per-task and whole-run aggregates, and gate outcomes while retaining the old
`generatedAt` and `results` fields. `--junit <path>` emits one testcase per
sample for CI consumers.
`--ab` supports repeated paired samples. Calls alternate A→B and B→A for each
successive `(task, sample)` pair; reports include per-arm success intervals,
paired-win intervals, and sample-cost distributions.

Every standard or A/B run also rebuilds `reports/trends.json` and
`reports/trends.md` from persisted report JSON. The scheduled workflow adds the
current report and trends to its step summary and uploads dedicated trend
artifacts.

Suite gates cover success rate, cost per success, tokens per success, tool
failure rate, and session error rate. When a baseline is supplied, they also
bound success-rate drop and cost/token/tool-failure regressions. Historical
baselines without token metrics are accepted, but malformed shapes, empty
samples, negative values, and non-finite numeric values are rejected.

## baseline.json

`baseline.json` records **real run results** (checks + execution metrics), so it
is only updated from an actual eval run, never by hand. Newly added tasks do not
count as pass→fail regressions. Copy a reviewed, representative report over
`baseline.json` only when intentionally refreshing the comparison point.

**Current baseline: 2026-08-11, all 68 tasks at three samples** — 203/204
(99.5%), $0.628 total, $0.0031 per success, 105,310 tokens per success, 1.54%
tool failures, 0 session errors, deepseek-v4-flash. `pagination-window-fix`
passed 2/3; every other task, including all five `graph-*` control-plane tasks,
passed 3/3. Every suite gate passed, including all four baseline-comparison
gates; the run still exits non-zero, because without `--fail-on-regression` a
single failed sample is enough.

> `gitSha` is `9891cd0` and the working tree was clean when the run started, so
> the numbers are attributable to exactly that commit — the previous baseline
> needed a paragraph reconciling a stamped sha with the core it exercised. The
> `datasetHash` is unchanged from the 2026-08-10 baseline, so this is a
> like-for-like comparison on the same 68 tasks.

**The one failure moved tasks, and that is not a measurement.** The previous
baseline's 203/204 came from `foreach-await-bug` at 2/3; this one's comes from
`pagination-window-fix` at 2/3, while `foreach-await-bug` went 3/3. The failing
sample left the buggy line in place (`file_not_contains` on
`const end = page * perPage;`) — an ordinary miss, not a new failure mode. Two
runs that each lose one sample out of 204, on different tasks, are the same
measurement; distinguishing two successes from three across three samples is
well inside noise. Treat any single task's 2/3 ↔ 3/3 movement as suggestive and
nothing more; a real answer needs a paired A/B on that task.

**Wall-clock is not comparable across runs.** This one took 112.3 minutes
against the previous baseline's 90.7, on a machine that was also running the
test suite. Duration p95 per task (84.6 s) is the number to watch; the total is
a property of the machine, not the model.

**Sample it three times.** Recorded at ONE sample the previous day, the same
suite reported 60/63 with `foreach-await-bug`, `go-pagination-window` and
`memory-convention-recall` failing. At three, the last two pass 3/3: they were
noise, and a single-sample baseline had frozen them as failures — which would
have made a later run that passed them look like an improvement, and set
`maxSuccessRateDrop` against an inflated failure count. Only
`foreach-await-bug` is a real weakness, and its 1/3 says so with a number.

**Read the per-check data before naming the weakness.** In both failing samples
of `foreach-await-bug`, `npm test` passed and the file contained `await`; the
only failed check was `file_not_contains "\.forEach\(async"`. The fixture's test
asserts order, length and a non-empty result, so a deterministic pass means the
async fix landed 3 times out of 3. What survived was the JSDoc line describing
the bug that had just been removed. The task discriminates **diff hygiene**, not
async semantics — a task name is a hypothesis, and the checks are the evidence.

The baseline before that was recorded 2026-07-01 against 49 tasks and carried
**no token metrics at all** — so `maxTokensPerSuccess` had only ever been
checked against its absolute ceiling, and that ceiling (100,000) was written
before the 14 long-running tasks added since (`loop-*`, `hard-*`,
`large-context-nav`). Measured since: 106,435 and 118,742 at one sample, 96,875
at three. The ceiling is **150,000** — headroom over the spread a single-sample
run produces, not a target. The gate that catches drift from here on is
`maxTokensPerSuccessIncreaseRatio` against this baseline, which for the first
time has tokens to compare against.

## Prompt A/B variants

A **variant** is a named, pure transform of the agent config, defined in
`packages/eval-harness/src/variants.ts` as `{ name, describe, apply(base) }`.
`apply` returns a new `AgentBuildOptions` (never mutates the base), which the
agent factory turns into core deps and/or a task-text suffix.

Built-in variants:

- `control` — identity (the baseline).
- `terse-prompt` — appends a brevity/no-narration instruction to the task.
- `llm-compaction` — flips full-context compaction to LLM summarization.
- `no-memory` — disables project-memory injection (pair with a memory-seeded task).
- `with-subagents` — gives the agent the builtin specialist subagents. The
  harness withholds them by default, and always has: `dispatch_agent` is in the
  catalog but has nothing to dispatch, so the specialists a real coding run uses
  were not merely unmeasured, they were unreachable here. Control keeps the old
  behavior so recorded comparisons stay valid; this variant is what prices them.
- `verify-gate` — sets `verifyCommand=npm test` so edits are verified before finishing.
- `no-auto-verify` — `verify-gate` but with `autoVerify=false` (nudge-only); A/B vs
  `verify-gate` to isolate the value of the loop auto-running the command.
- `no-retrieval` — disables the auto-injected task-relevant file shortlist; pair with a
  fixture that clears the 40-code-file retrieval floor (`cjk-buried-discount`,
  `cjk-buried-retry`) — smaller fixtures never trigger retrieval, so the A/B is a no-op.
- `review-gate` — enables the final-review gate (`finalizeReview`).
- `no-progress-guard` — enables the premature-finish guard.
- `model-pro` — runs the suite under `deepseek-v4-pro` instead of the configured
  default, so a capability A/B can be re-run under a stronger model.

Suggested A/B pairs for the round-52 capabilities:
`--ab control,no-retrieval --task cjk-buried-discount,cjk-buried-retry` (retrieval, on the
CJK fixtures that clear the 40-file floor), `--ab verify-gate,no-auto-verify` (auto-run),
`--ab control,review-gate` (final review). The `cjk-*` tasks are Chinese (code-switched)
prompts: only an English bridge word in the task can match ASCII code, so they also probe
how retrieval behaves on CJK prompts.

Add one by appending an entry to the `VARIANTS` array. Knobs available without
forking core: `compaction`, `contextWindowTokens`, `injectMemory`, `verifyCommand`,
`autoVerify`, `injectRelevantFiles`, `finalizeReview`, `guardNoProgress`, and
`taskSuffix` (the only seam to influence the prompt while keeping skill selection
intact — replacing the system prompt outright would disable skills, see `agent/loop.ts`).

```bash
# Single run under a variant (default: control)
pnpm --filter @seekforge/eval-harness eval -- --variant terse-prompt
pnpm --filter @seekforge/eval-harness eval -- --list-variants

# Paired A/B with three samples per task; writes .json and .md reports.
pnpm --filter @seekforge/eval-harness eval -- --ab control,terse-prompt --repeat 3
```

The A/B table reports each paired task/sample, arm success / score / turns /
cost and a winner (success, then higher score, fewer turns, then cheaper), plus
success-rate and paired-win 95% confidence intervals and cost distributions.

## Measurement runbook: round-52 transparent capabilities

The round-52 features (relevant-files retrieval, auto-verify, reviewer subagent)
shipped explicitly unmeasured ("wants dogfooding"). These commands put numbers on
them. All need a configured `DEEPSEEK_API_KEY` and are billed real runs.

```bash
cd packages/eval-harness

# 1) Retrieval — ONLY on fixtures that clear the 40-code-file floor. The
#    cjk-large-paginate fixture (159 files) also triggers the repo-overview
#    (>=150) — the only fixture that exercises either orientation feature.
pnpm exec tsx src/cli.ts --ab control,no-retrieval \
  --task cjk-buried-discount,cjk-buried-retry,cjk-large-paginate

# 2) Auto-verify — does auto-running the verify command beat just nudging?
pnpm exec tsx src/cli.ts --ab verify-gate,no-auto-verify --task loop-verify-green

# 3) Reviewer/self-review gate — worth its tokens?
pnpm exec tsx src/cli.ts --ab control,review-gate

# 4) Weak vs strong — re-run any capability A/B under the stronger model to
#    check whether a transparent lever helps the weaker default model MORE.
#    (model-pro flips the model; compose by editing config.model for the other arm.)
pnpm exec tsx src/cli.ts --ab control,model-pro
```

Record a baseline once a run looks representative, then gate later runs on it:

```bash
# Write a report, copy it to evals/baseline.json, then on later runs:
pnpm exec tsx src/cli.ts --baseline ../../evals/baseline.json --fail-on-regression
```

Dogfood the loop on a real repo (complements the synthetic fixtures): point the
core auto-loop at SeekForge itself with `verifyCommand="pnpm -r test"` and watch
where it self-verifies to green vs stalls (see docs/loop-engineering.md).

## Skill-effectiveness ranking

Core logs the skills it selects per session into the throwaway workspace's
`.seekforge/skills-usage.jsonl`; the harness captures that into each
`TaskResult.skills` before the workspace is wiped. `--skill-ranking` appends a
table aggregating across the run: per skill → times used → success rate when
active → success-rate delta vs the run baseline → avg score/turns → turns delta.

```bash
pnpm --filter @seekforge/eval-harness eval -- --skill-ranking
pnpm --filter @seekforge/eval-harness eval -- --ab control,llm-compaction --skill-ranking
```

On the current dataset, skills fire on 13/14 tasks (only `ask-codebase` selects
none), so the ranking has real data — `verify-change`, `test-failure-fix`,
`small-code-change`, and `bugfix` are the most frequently selected.

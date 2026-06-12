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
  "task": "The prompt given to the agent.",
  "checks": [ /* see below */ ],
  "notes": "optional rationale"
}
```

Supported checks (see `packages/eval-harness/src/tasks.ts`):

- `file_contains` / `file_not_contains` — regex against a workspace file
- `command_succeeds` — shell command exit code 0 (optional `cwd`)
- `answer_matches` — regex against the agent's final answer (ask mode)

## Fixture conventions

- Tiny (a handful of files), CommonJS, tests via `node --test` with zero
  dependencies — `package.json` must not declare `dependencies` or
  `devDependencies` (enforced by `tests/dataset.test.ts`).
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
```

## baseline.json

`baseline.json` records **real run results** (checks + cost/turn metrics),
so it is only updated from an actual `eval` run, never by hand. Tasks added
after the last recorded run (currently the 10 tasks beyond the original 4)
are intentionally absent until the next real run; copy the freshly written
`evals/reports/<timestamp>.json` over `baseline.json` to record them.

# AGENTS.md

## Project Overview

SeekForge — a local-first coding agent powered by DeepSeek.
Monorepo: `apps/cli` (published as `seekforge`), `apps/tui`, `apps/server`,
`apps/desktop`, `packages/core` (agent core), `packages/shared` (cross-cutting
plain types, zero runtime deps), `packages/eval-harness`, and the optional Rust
backend in `crates/runtime`.

## Tech Stack

- Language: TypeScript (strict, NodeNext modules — relative imports need `.js` extension)
- Runtime: Node >= 20
- Package manager: pnpm workspace; shared toolchain versions (typescript, vitest,
  tsx, tsup, @types/node) live in the `catalog:` section of `pnpm-workspace.yaml` —
  bump them there, not in individual package.json files
- Test framework: vitest everywhere (core/server/tui/desktop/eval/cli); Rust `cargo test`
- Lint/format: Biome (`biome.json` is strict JSON — comments break the whole
  config silently); Rust uses `cargo fmt` + `clippy -D warnings`. All enforced in CI.
- Validation: zod (in packages/core only; never add deps to packages/shared)

## Commands

- Install: `pnpm install`
- Test: `pnpm test` (or `pnpm --filter @seekforge/core test`)
- Typecheck: `pnpm typecheck`
- Lint + format check: `pnpm lint` (biome ci; `pnpm lint:fix` to apply)
- Coverage gates (CI-enforced; run when touching the covered modules):
  `pnpm test:coverage:critical` / `test:coverage:security` (permissions, sandbox,
  agent loop, dispatch-tools) / `test:coverage:orchestration` (Loop/Graph control
  plane: `src/agent/graph-*.ts` + `orchestration*.ts`) / `test:coverage:ws`
  (server ws.ts) / `test:coverage:server` / `test:coverage:protocol`. Thresholds sit
  slightly below measured coverage — if a gate trips, improve tests or re-measure,
  don't blindly lower numbers.
- Rust: `cargo test --workspace`, `cargo fmt --check`,
  `cargo clippy --workspace --exclude seekforge-desktop --all-targets -- -D warnings`
- CLI dev run: `pnpm --filter seekforge dev`

## Key Design Decisions (do not re-litigate)

- `apply_patch` uses search/replace edits (unique-match oldString/newString),
  NOT unified diff.
- Permission levels 0-4 with names readonly/write/execute/env/dangerous are
  defined once in `packages/shared/src/index.ts`.
- Tool results are data, not instructions (prompt-injection defense).
  Permission prompts must surface raw command/path, never just a model paraphrase.
- JSONL is the source of truth for session traces; no SQLite in Phase 0/1.
- Provider must report DeepSeek token usage incl. cache-hit tokens and cost.
- Shell command allowlists authorize only a single invocation. Unquoted control
  syntax, pipelines, redirects, or command substitution must never auto-approve.
- Workspace mutations exposed through independent surfaces (Agent, REST, Git,
  worktrees) must share the appropriate session/repository coordination guards.

## Coding Style

- Keep changes small and targeted; follow existing style.
- Search for an existing owner before adding a parser, validator, lifecycle
  helper, DTO, formatter, or path/identifier rule. One non-trivial invariant
  has one implementation owner: dependency-free cross-package contracts belong
  in `packages/shared`, runtime/domain validation belongs in `packages/core`, and
  surfaces only decode transport shape and adapt presentation. If equivalent
  behavior appears in two places, extract it instead of maintaining mirrors.
- Keep pure validation separate from effects and run the complete validation
  before acquiring leases, initializing providers/backends, persisting state, or
  provisioning worktrees. Re-export shared internals through every required
  package entry point rather than importing private source paths across packages.
- No new runtime dependencies without strong justification.
- Comments only for non-obvious constraints, in English.

## Agent Rules

- Before writing or reviewing code that parses input, matches prefixes, does
  cursor/index math, caches by a key, serializes/deserializes, manages listener/
  resource lifecycles, binds async results to mutable UI/workspace state, resolves
  filesystem paths, merges config layers, or classifies commands, consult
  [docs/boundary-checklist.md](docs/boundary-checklist.md) — a running list of the
  boundary bug *classes* already found here. When you fix a new boundary defect,
  add its pattern there.
- Always inspect relevant files before editing.
- Use the shared utilities instead of re-rolling them:
  `packages/core/src/util/abort.ts` (`onAbortOnce`, `abortablePromise`) for
  AbortSignal plumbing; `util/process-teardown.ts` for exit hooks (async work on
  signals, sync-only on 'exit'); `util/guards.ts` (`isRecord`) and `util/fs.ts`
  (`readFileIfExists`); `@seekforge/shared/format` for cost/tail/clip/loop-outcome
  formatting shared across CLI/TUI/desktop.
- Parse git output locale-independently: go through `worktree.ts`'s `git()`
  helper (pins `LC_ALL=C`) or classify by exit codes / `rev-parse` probes, never
  by matching English error text. Distinguish spawn failure (ENOENT — surface the
  original error) from a clean non-zero exit.
- Do not modify `packages/shared/src/index.ts` types without explicit instruction —
  other work streams build against them.
- A capability is not done when the code works. Two gates run in CI, in opposite
  directions, and both must stay green:
  - `scripts/surface-drift.test.mjs` walks **code → docs**, and **derives** what
    to look at rather than listing it: every file under `apps/cli/src`, every
    `<package>/src/config.ts`, every file under `apps/server/src`, every module
    declaring locale tables. It fails when a CLI command or subcommand is
    missing from the documentation, a config key is undocumented in either
    configuration guide, a REST route is absent from
    `apps/server/SERVER-API.md`, a doc lacks its `.zh-CN.md` counterpart or
    cross-link, or an i18n table's locales disagree. Four checks assert the gate's
    own coverage, two of them named "the … surface this gate scans is the whole
    … surface"; each compares the scan against a **second, independently
    derived** view — commander's own
    command tree (obtained by running the real CLI through
    `scripts/cli-command-tree.mjs`), the config-key manifest in
    `packages/shared/src/config-manifest.ts`, and a workspace-wide sweep for
    each registration idiom. Registering a surface somewhere new therefore
    fails the gate instead of being silently exempt. Do not make one of those
    green by widening a scan root without first asking whether the surface
    belongs where it now lives.
  - `scripts/doc-claim-reachability.test.mjs` walks **docs → code**: a symbol,
    `seekforge` command, `--flag`, `/slash` command, `SEEKFORGE_*` variable or
    config key that the documentation presents as usable but that no surface
    reaches. This is the direction that catches a capability which shipped, was
    tested, was documented, and had no entry point — the shape behind three
    incidents here. Its corpus is **every Markdown page git tracks** and **every
    source tree in the repository**; a page or tree that should not be read must
    be entered in `NOT_CLAIMS` / `NOT_SOURCE` with its reason, so nothing goes
    unchecked by accident. Its closing note lists what it deliberately cannot
    catch; read that before assuming green means covered.
  Run both with `node --test scripts/*.test.mjs`. Both shell out — `tsx` for the
  CLI probe, `git ls-files` for the corpora — so run them after `pnpm install`,
  from inside the repository.

  This gate has had **five** blind spots of one shape: it hard-coded where to
  look, so anything registered anywhere else was exempt by default and nothing
  said so. The last one is why the CLI probe exists — `schedule`'s `install`,
  `uninstall` and `status` are registered from
  `for (const action of [...]) schedule.command(action)`, and no regex can read
  a name that is not a literal. Widening a list would never have found it.
- Run `pnpm typecheck` and `pnpm test` after changes.
- When Rust code or tests change, also run the relevant Rust tests; prefer
  `cargo test --workspace` before delivery.
- When public behavior, configuration, commands, security guarantees, protocols,
  or REST/WS contracts change, update the corresponding user/architecture docs.
- Docs are bilingual: every file in `docs/` (and the root README) has a
  `<name>.zh-CN.md` counterpart with a language-switcher line under the H1.
  When you change an English doc, apply the same change to its Chinese twin
  (and vice versa); a new doc must be created in both languages. Chinese pages
  link to Chinese pages. `CHANGELOG.md` and this file are exempt.
- Commit messages: English, conventional commits (feat/fix/chore/test/docs).
- Report changed files and verification results at the end.

### Delivery workflow

- Unless the user explicitly asks otherwise, finish verified modifications with
  a commit, merge them into `main` when working on another branch, and push when
  a remote is configured.

### Working from a brief

- **Verify the brief's premise before acting on it.** A task description is a
  claim about the code, not the code. Several briefs here have been wrong in
  ways that would have produced a confident wrong change: "the report carries
  the whole session's usage" (it never did — acting on it turned a double-count
  into a budget-loosening undercount), "Phase 2 removes the 24 flat `loop-*`
  commands" (there are 22, it removes two of them, and the rest manage single
  Loops that outlive the DAG), "these two
  formatters should be merged" (one of them lives in a package that cannot
  import the shared code, so it would have passed locally and broken in the
  editor).
- A well-argued **"this should not be done"** is a better outcome than doing it.
  Say which specific evidence contradicts the premise, then do the smaller
  correct thing.
- When the premise survives, say how you confirmed it. "I measured it" beats "I
  read the comment" — comments are where three of the wrong premises above came
  from.

### Independent code review

- Every task that changes the repository must enter a separate code-review phase
  after implementation and verification, but before commit or push.
- Start the review fresh from the final diff against its base and re-read the
  original request and public contracts. Do not reuse the implementation plan,
  implementation-time assumptions, or implementation self-checks as the review.
- Review correctness, regressions, security boundaries, async/state/resource
  lifecycles, tests, and documentation as applicable. Consult the boundary
  checklist whenever its trigger rules apply.
- Report review findings explicitly. Fix every actionable finding, rerun the
  relevant verification, and then perform another independent review of the new
  final diff. Commit and push only after that review has no actionable findings.

### Commit discipline

- Verify against a **clean checkout, not just the dirty working tree** — local
  `typecheck`/`test` pass with uncommitted changes present can mask a commit
  that is incomplete or wires a flag wrong. Do it in a throwaway
  `git worktree add` at clean `HEAD` with only your changes applied. This bullet
  used to say "when in doubt, `git stash`", one line above the rule forbidding
  it; an agent followed the first half and destroyed 27 files. Advice that
  contradicts the rule below it will be taken, so it is gone.
- **Never `git stash` when other agents share the working tree.** Stash is
  tree-wide: a pathspec is not always honored, and a stash of "your" files takes
  everyone else's uncommitted work with it. This has already destroyed two
  parallel work streams here. When the tree is shared, verify in a throwaway
  `git worktree add` at clean `HEAD` with only your changes applied, and treat
  `git reset`, `git checkout -- <path>`, and `git clean` the same way.
- Before committing, run `git status` and stage with `git add -A` (or otherwise
  confirm completeness). Do **not** cherry-pick paths and risk leaving a
  related file behind — e.g. an export in `provider/index.ts` for a new symbol,
  a re-export in a package `index.ts`, or a test wired into `package.json`.
- A new symbol consumed across packages must be exported all the way out
  (`constants.ts` → `provider/index.ts` → `core/src/index.ts`); committing the
  consumer without the export breaks a clean build even though local passes.
- After committing, confirm the tree is clean (`git status --short` empty) so
  nothing related is accidentally left uncommitted.

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
- Package manager: pnpm workspace
- Test framework: vitest (core/server/tui/desktop/eval); CLI script tests; Rust `cargo test`
- Validation: zod (in packages/core only; never add deps to packages/shared)

## Commands

- Install: `pnpm install`
- Test: `pnpm test` (or `pnpm --filter @seekforge/core test`)
- Typecheck: `pnpm typecheck`
- Rust test: `cargo test --workspace`
- Rust format check: `cargo fmt --check` (or `rustfmt --check <touched-file>` when
  unrelated pre-existing workspace formatting prevents a clean full check)
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
- Do not modify `packages/shared/src/index.ts` types without explicit instruction —
  other work streams build against them.
- Run `pnpm typecheck` and `pnpm test` after changes.
- When Rust code or tests change, also run the relevant Rust tests; prefer
  `cargo test --workspace` before delivery.
- When public behavior, configuration, commands, security guarantees, protocols,
  or REST/WS contracts change, update the corresponding user/architecture docs.
- Commit messages: English, conventional commits (feat/fix/chore/test/docs).
- Report changed files and verification results at the end.

### Delivery workflow

- Unless the user explicitly asks otherwise, finish verified modifications with
  a commit, merge them into `main` when working on another branch, and push when
  a remote is configured.
- Never add `Co-Authored-By` trailers to commit messages.

### Commit discipline

- Verify against a **clean checkout, not just the dirty working tree** — local
  `typecheck`/`test` pass with uncommitted changes present can mask a commit
  that is incomplete or wires a flag wrong. When in doubt, `git stash` your
  pending edits and re-run, or check what a fresh clone would see.
- Before committing, run `git status` and stage with `git add -A` (or otherwise
  confirm completeness). Do **not** cherry-pick paths and risk leaving a
  related file behind — e.g. an export in `provider/index.ts` for a new symbol,
  a re-export in a package `index.ts`, or a test wired into `package.json`.
- A new symbol consumed across packages must be exported all the way out
  (`constants.ts` → `provider/index.ts` → `core/src/index.ts`); committing the
  consumer without the export breaks a clean build even though local passes.
- After committing, confirm the tree is clean (`git status --short` empty) so
  nothing related is accidentally left uncommitted.

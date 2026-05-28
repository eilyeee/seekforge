# AGENTS.md

## Project Overview

SeekForge — a local-first coding agent powered by DeepSeek.
Monorepo: `apps/cli` (published as `seekforge`), `packages/core` (agent core),
`packages/shared` (cross-cutting plain types, zero runtime deps).

## Tech Stack

- Language: TypeScript (strict, NodeNext modules — relative imports need `.js` extension)
- Runtime: Node >= 20
- Package manager: pnpm workspace
- Test framework: vitest (in packages/core)
- Validation: zod (in packages/core only; never add deps to packages/shared)

## Commands

- Install: `pnpm install`
- Test: `pnpm test` (or `pnpm --filter @seekforge/core test`)
- Typecheck: `pnpm typecheck`
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

## Coding Style

- Keep changes small and targeted; follow existing style.
- No new runtime dependencies without strong justification.
- Comments only for non-obvious constraints, in English.

## Agent Rules

- Always inspect relevant files before editing.
- Do not modify `packages/shared/src/index.ts` types without explicit instruction —
  other work streams build against them.
- Run `pnpm typecheck` and `pnpm test` after changes.
- Commit messages: English, conventional commits (feat/fix/chore/test/docs).
- Report changed files and verification results at the end.

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

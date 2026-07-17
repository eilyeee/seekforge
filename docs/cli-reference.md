# CLI reference

> **English** | [简体中文](cli-reference.zh-CN.md)

Flag reference for `seekforge run`, `seekforge ask`, and `-p` headless mode.

## Legend

- **run** — applies to `seekforge run "<task>"`
- **ask** — applies to `seekforge ask "<question>"`
- **-p** — applies to `seekforge -p "[prompt]"` (headless single-run)
- **chat** — applies to `seekforge` (interactive REPL session)
- ✦ — also settable in config/project settings

## Common flags

| Flag | Applies to | Description |
| --- | --- | --- |
| `-y, --yes` | run, ask, -p, chat | Auto-approve write/execute permissions (env-level still asks) |
| `-m, --model <model>` ✦ | run, ask, -p, chat | Override model (`deepseek-v4-flash` / `deepseek-v4-pro`) |
| `--json` | run, ask, -p | Alias for `--output-format stream-json` (machine mode; prompts denied, pair with `-y`) |
| `--output-format <fmt>` | run, ask, -p | `text` (default human), `json` (Claude-style result object), `stream-json` (JSONL envelopes), `stream-json-raw` (raw events) |
| `-c, --continue` | run, ask, -p | Resume the most recent session |
| `--resume <id>` | run, ask, -p | Resume a specific session (see `seekforge sessions`) |
| `--add-dir <path>` | run, ask, -p | Extra read-only root for `@`-references (repeatable) |
| `--max-turns <n>` | run, ask, -p | Cap agent turns |
| `--max-cost <usd>` | run, -p | Stop the run once cumulative cost reaches this budget (USD); graceful cancel, trace kept. Also settable as the `maxCostUsd` config key (applies to all modes) |
| `--settings <file>` | run, ask, -p, chat | Path to JSON settings file (layered over project config but below env/CLI flags) |
| `--profile <name>` ✦ | run, ask, -p, chat | Apply a named `profiles` overlay from the config files; also `SEEKFORGE_PROFILE` env (flag wins). The overlay slots just below `--settings`. Available as a global flag and on `run` / `ask` / `loop` |

## Run-specific flags

| Flag | Description |
| --- | --- |
| `--plan` | Plan first (read-only), confirm, then execute in the same session |
| `--permission-mode <mode>` | `default` / `confirm` — prompt on write/execute; `acceptEdits` — auto-allow in-workspace edits, prompt on commands; `plan` — confirm + plan-first; `bypassPermissions` / `auto` — full auto (like `-y`). Overrides `-y` when set |
| `--fallback-model <model>` | Model to retry with if the primary is overloaded |
| `--output-style <style>` | `default` (no change), `concise` (maximally terse), `explanatory` (teach as you answer), `learning` (leave 1–3 pieces for the user), or a custom `.seekforge/output-styles/<name>.md` (see Configuration) |
| `--system-prompt <text>` | Replace the system prompt entirely |
| `--append-system-prompt <text>` | Append text to the system prompt |
| `--allowedTools <list>` | Only allow these tools (comma-separated) |
| `--disallowedTools <list>` | Deny these tools (comma-separated) |
| `--dangerously-skip-permissions` | Alias for `-y` — auto-approve write/execute (dangerous commands are still refused; env changes still ask) |
| `--mcp-config <file>` | Load MCP servers from a JSON file (merged over config, unless `--strict-mcp-config`) |
| `--strict-mcp-config` | Use only `--mcp-config` servers, ignore config-file MCP servers |
| `--verbose` | Print full tool args and results |

## Ask-specific flags

| Flag | Description |
| --- | --- |
| `--verbose` | Print full tool args and results |

## Headless (`-p`) flags

In addition to the common flags above:

| Flag | Description |
| --- | --- |
| `--ask` | Read-only Q&A mode (no writes/commands) |
| `-p, --print [prompt]` | Headless single-run: stream the result to stdout and exit (reads piped stdin) |
| `--output-format <fmt>` | See Common flags — also accepts `stream-json-raw` |
| `--permission-mode <mode>` | See run-specific |
| `--fallback-model <model>` | See run-specific |
| `--output-style <style>` | See run-specific |
| `--system-prompt <text>` | See run-specific |
| `--append-system-prompt <text>` | See run-specific |
| `--allowedTools <list>` | See run-specific |
| `--disallowedTools <list>` | See run-specific |
| `--dangerously-skip-permissions` | See run-specific — alias for `-y` |
| `--include-partial-messages` | With `-p` + `--output-format stream-json`: emit partial assistant text deltas |
| `--input-format <fmt>` | `text` (default) or `stream-json` (line-delimited user turns on stdin) |
| `--mcp-config <file>` | See run-specific |
| `--replay-user-messages` | With `-p` + `--input-format stream-json`: echo each user turn back as a stream-json event |
| `--strict-mcp-config` | See run-specific |
| `--verbose` | See run-specific |

## Per-hunk partial-apply

When `apply_patch` is called with **more than one edit**, the tool classifies each
edit as a separate hunk with a short preview. The permission prompt then offers
per-hunk selection in the CLI terminal (`Pick hunks (e.g. 0,2)`), in the TUI
(per-hunk checkboxes), and in the desktop modal.

When the user selects only a subset of hunks, the agent receives the filtered
edits and applies only those. Single-edit `apply_patch` calls remain all-or-nothing
for backward compatibility.

## Settings layering

`--settings <file>` loads a JSON file that slots between the local/project
config layers and env/CLI flags:

| Layer | Precedence |
| --- | --- |
| `DEEPSEEK_API_KEY` env var | highest |
| CLI flags (`--model`, `-y`, …) | ↑ |
| `--settings <file>` (JSON) | ↑ |
| selected `--profile` overlay (if any) | ↑ |
| `.seekforge/config.local.json` (personal, gitignored) | ↑ |
| `.seekforge/config.json` (project) | ↑ |
| `~/.seekforge/config.json` (global) | lowest |

For deep-merge fields (`mcpServers`, `permissionRules`, `hooks`), the settings
layer merges into the existing logic rather than replacing wholesale.

## Session commands

Beyond the run/ask flags above, these subcommands operate on stored sessions
(under `.seekforge/sessions/`):

| Command | What it does |
| --- | --- |
| `seekforge sessions` | List recent sessions (id, status, task) |
| `seekforge resume <id>` | Continue a session (also `run/ask -c` for the latest) |
| `seekforge replay <session>` | Deterministically re-render a stored session's events to stdout — no model calls, no cost. `--verbose` for full tool args/results |

## GitHub issue and review workflows

These commands require an authenticated `gh`, an `origin` remote, and an
explicit positive cost budget. The agent edits and verifies; the user-invoked
command performs commit, push, PR creation, and CI inspection.

| Command / flag | Description |
| --- | --- |
| `seekforge resolve <issue> --max-cost <usd>` | Fetch an issue, fix it in an isolated worktree, verify, commit, push, and open a draft PR. `<issue>` may be a number or GitHub issue URL. |
| `seekforge resolve-review <pr> --max-cost <usd>` | Check out a PR in an isolated worktree, address actionable comments/reviews, verify, commit, and push fixes. |
| `--base <branch>` | `resolve` only: PR base branch; defaults to `main`. |
| `-m, --model <model>` | Override the model for the bounded headless run. |
| `--no-draft` | `resolve` only: create a ready-for-review PR instead of a draft. |
| `--no-worktree` | Deliberately use and change the current checkout instead of the default temporary worktree. |
| `--wait-ci` | Wait for `gh pr checks --watch --fail-fast` after pushing. |
| `--dry-run` | Run the agent and verification, then print commit/push/PR commands without executing outward actions. The worktree is retained for inspection. |

See [Autonomous GitHub issue → PR](github.md) for lifecycle, cleanup, and
security details.

## Autonomous verification loop

`seekforge loop <task> --verify <command>` repeatedly runs the agent and the
verification command until it passes or a guardrail stops the loop. Verification
uses the shared shell executor with the configured OS sandbox and responds to
cooperative cancellation.

| Flag | Description |
| --- | --- |
| `--verify <command>` | Required success criterion; exit code 0 passes. |
| `--max-iters <n>` | Maximum agent iterations; defaults to 8 and cannot exceed 100. |
| `--budget <usd>` | Stop further work when observed cumulative usage reaches the value. An in-flight provider request can make final billed cost slightly exceed it. |
| `--worktree [name]` | Run in a new retained git worktree; optionally choose its branch suffix. |
| `-y, --yes` | Suppress the autonomous-edit notice; loop runs already use `acceptEdits`. |
| `-m, --model <model>` | Override the configured model. |
| `--profile <name>` | Apply a named configuration profile. |

Every invocation persists orchestration state in `.seekforge/loops/`. Use
`seekforge loop-resume <loop-id> [--add-iters N] [--add-budget USD]` to continue with the saved session, cost, and
remaining iterations. For `--worktree` loops, run that command inside the
retained worktree shown at startup. Verification output streams while checks run;
the interactive TUI exposes the same workflow through `/loop`.

`seekforge loop-list`, `loop-show`, and `loop-delete` manage persisted records.
`seekforge loop-cleanup <name>` removes a retained `seekforge/loop-*` worktree;
dirty worktrees require explicit `--force` because their changes are discarded.

## Repository security

`seekforge security` maintains an append-only Finding queue under
`.seekforge/security/events.jsonl`. Agent scan output is accepted only after
strict schema, repository-relative path, line-range, and exact-excerpt
validation.

| Command | Description |
| --- | --- |
| `security scan [--max-findings N] [--json]` | Run a repository-wide read-only Agent security scan. |
| `security list [--status S] [--severity S] [--json]` | List current Findings. |
| `security show <id> [--json]` | Show evidence and remediation for one Finding. |
| `security status <id> <status> [--reason TEXT]` | Record a lifecycle transition. |
| `security fix <id> --max-cost USD [-y]` | Run an Agent fix, project checks, and verification rescan. |
| `security verify <id>` | Run project checks and rescan without editing. |
| `security threat-model [--json]` | Generate an evidence-backed threat model. |
| `security export --format json\|markdown\|sarif [-o PATH]` | Export a redacted evidence package. |

The lifecycle is `open`, `triaged`, `fixing`, `resolved`, `accepted_risk`,
`dismissed`, or `reopened`. Verification is tracked separately as `unverified`,
`verified`, `failed`, or `stale`. See [Security scanning](security-scanning.md)
for verification rules and compliance limitations.

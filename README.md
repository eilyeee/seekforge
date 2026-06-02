# SeekForge

**A local-first coding agent powered by DeepSeek.**

SeekForge is a coding agent for real-world projects: it reads your codebase,
understands the task, plans changes, edits files, runs verification, keeps
fixing on failure, and finally presents a reviewable diff with a summary and
token/cost usage.

```bash
cd your-project
seekforge run "修复登录按钮点击无响应的问题"
```

```txt
session 20260610T110258-c1pbi7
· skills: bugfix
→ search_text {"pattern":"login.*button"}
✓ search_text
→ read_file {"path":"src/components/LoginButton.vue"}
✓ read_file
→ apply_patch {"path":"src/components/LoginButton.vue", ...}
✓ apply_patch
● changed src/components/LoginButton.vue
→ run_command {"command":"pnpm test"}
✓ run_command
...
Tokens: 38.7K prompt (33.2K cache hit) / 6.1K completion   Cost: $0.0124
```

## Status

✅ **Step 1 — CLI** (usable today): agent loop with context compaction,
sandboxed tools, 5-level permission policy, session resume, streaming,
skills, reviewable project memory, optional Rust execution backend.

✅ **Step 2 — surfaces** (0.7.0): `seekforge-tui` is a full
Claude-Code-parity terminal UI; `seekforge serve` ships a local web
workbench (React) plus a Tauri desktop shell; subagents, self-evolution
and an evaluation harness are in. Current focus: real-world polish
(dogfooding, eval expansion).

## Install & setup

```bash
# from npm (CLI)
npm install -g seekforge

# or from source
git clone https://github.com/eilyeee/seekforge && cd seekforge
pnpm install && pnpm typecheck && pnpm test

# configure the DeepSeek API key (one of):
seekforge config set apiKey sk-... --global     # ~/.seekforge/config.json (0600)
export DEEPSEEK_API_KEY=sk-...
```

## Commands

| Command | What it does |
| --- | --- |
| `seekforge` | **interactive session** (REPL): multi-turn conversation, `/help` for slash commands (`/new` `/sessions` `/resume` `/model` `/usage`) |
| `seekforge completion bash\|zsh` | print a static shell completion script to source from your rc file |
| `seekforge-tui` | **terminal UI** (Ink): full Claude-Code-parity daily driver — command palette + argument pickers, vim mode, steering queue, run detach (Ctrl+B), per-turn backtrack with file restore, thinking display, opt-in OS sandbox, MCP over HTTP, custom commands and skills as slash commands; full list in [apps/tui/README.md](apps/tui/README.md) |
| `seekforge serve [paths...] [--port 7373]` | local web UI + agent API; pass multiple workspace paths to host them together (127.0.0.1 only, token-protected) |
| `seekforge run "<task>"` | run a development task; `-y` auto-approves safe writes/commands, `-m` overrides the model, `--json` emits JSONL events for CI, `--plan` plans read-only first and executes after your confirmation. More flags: [`--permission-mode`, `--output-style`, `--fallback-model`, `--settings`, `--system-prompt`, `--append-system-prompt`, `--allowedTools`, `--disallowedTools`, `--add-dir`, `--verbose`](docs/cli-reference.md) |
| `seekforge ask "<question>"` | read-only Q&A (writes and commands disabled); supports `--add-dir`, `--settings`, `--verbose` and [most run flags](docs/cli-reference.md) |
| `seekforge models` | list available DeepSeek models, their pricing (cache miss/hit, output per 1M tokens), default (`deepseek-v4-flash`), and deprecated entries |
| `seekforge resume <session-id> [task]` | continue a session with its full history (keeps its ask/edit mode) |
| `seekforge sessions` | list sessions with status and cost (subagent runs hidden) |
| `seekforge sessions prune [--older-than <days>] [--keep-last <n>] [--dry-run]` | delete old session traces to keep `.seekforge/sessions/` bounded |
| `seekforge rewind [session-id] [--dry-run]` | undo all file changes a session made (pre-write checkpoints) |
| `seekforge memory add "<fact>" [--type] [--pending]` / `remove <n\|id\|text>` | tell the agent something directly (REPL: `/remember <fact>`) |
| `seekforge status` | project / config / last-session overview |
| `seekforge update` | check npm for a newer seekforge version and print the install command |
| `seekforge diff` | show the current git diff |
| `seekforge doctor` | run environment diagnostics (api key, node, git, runtime, mcp, editor, clipboard) |
| `seekforge evolve analyze\|list\|show\|accept\|reject\|apply` | score sessions and review self-evolution proposals (human-gated) |
| `seekforge init` | scaffold `.seekforge/` and an `AGENTS.md` template |
| `seekforge mcp add\|list\|remove <name>` | manage MCP servers in config (list, add a stdio server, or remove) — see [docs/mcp.md](docs/mcp.md) |
| `seekforge mcp-serve [--allow-write]` | run SeekForge as an MCP server on stdio (read-only tool set by default); `--allow-write` exposes write tools (TRUSTED callers only) |
| `seekforge skill list\|show\|create\|enable\|disable <id>` | procedure skills (project > global > builtin); enable/disable toggles a skill |
| `seekforge skill import <path> [-g] [-f]` | import a Claude-style SKILL.md (YAML frontmatter) as a project or global skill |
| `seekforge agent list\|show <id>\|import <path>` | manage subagents; the main agent delegates bounded sub-tasks via `dispatch_agent` |
| `seekforge memory list\|approve <id>\|reject <id>` | review extracted facts into long-term project memory |
| `seekforge memory compact [--dry-run] [--prune-unused <days>]` | collapse duplicate and near-duplicate facts in project.md (deterministic); `--prune-unused` archives never-used facts older than `<days>` to `project-archive.md` |
| `seekforge memory stats` | print memory extraction-quality stats — approved/pending/rejected counts, used fraction, rejection rate (read-only); inspect this before tuning `memoryAutoApproveConfidence` |
| `seekforge config show\|set <key> <value> [-g]` | `set` accepts the scalar/array keys: `apiKey`, `model`, `baseUrl`, `runtimeBin`, `commandAllowlist`, `models`, `sandbox`, `thinking` / `reasoningEffort`, `compaction`. Structured keys (`permissionRules`, `hooks`, `mcpServers`, `planModel`) are **edited directly in `.seekforge/config.json`** — not via `config set`. Config layers: env vars > CLI flags > [`--settings <file>`](docs/cli-reference.md#settings-layering) > project `.seekforge/config.json` > global `~/.seekforge/config.json`. Full reference: [docs/configuration.md](docs/configuration.md) |

Headless single-run via `seekforge -p "<prompt>"` accepts the same flags as
`seekforge run` plus `--ask`, `--input-format` (text | stream-json),
[see the full list](docs/cli-reference.md).

`Ctrl+C` cancels a running session cooperatively (the trace is kept, so
`seekforge resume` can pick it up); a second `Ctrl+C` force-quits.
`@path` tokens in a task inline that file's content (sensitive files excluded).
The agent can also: publish a live plan checklist (`update_plan`), commit its
work (`git_commit` — push stays impossible), and fetch public docs pages
(`web_fetch` — every URL needs explicit confirmation; private addresses refused).

## Desktop workbench

`seekforge serve` opens a local, token-protected web workbench (React) — on
`127.0.0.1` only — that the Tauri shell wraps as a native macOS app. It drives
the **same** agent/API as the CLI, in a light, Codex-style UI (dark mode opt-in;
language follows en / zh-CN), with every surface in one window:

- **Chat** — multi-tab sessions with a home screen (quick-action starters +
  recent sessions/skills/agents), streaming tool-run cards, per-hunk diff
  approval, plan execution, and a composer with `@` file mentions, `/` commands,
  image attach/paste, and a thinking toggle.
- **Sessions · Changes · Skills · Subagents · Memory · Evolution · Settings** —
  resume sessions, review the working-tree diff, toggle skills, inspect
  subagents, approve memory candidates, gate self-evolution proposals, and edit
  config (model list, sandbox, theme, language…).
- **Todos** — a side panel backed by `.seekforge/todos.md`.

```bash
seekforge serve                                     # open the printed URL in a browser
pnpm --filter @seekforge/desktop build && pnpm tauri dev   # or the native app (dev)
```

The bundled app needs the `seekforge` CLI reachable (it spawns `seekforge serve`);
see [apps/desktop/src-tauri/README.md](apps/desktop/src-tauri/README.md).

## How it works

- **Edits are search/replace patches** (`oldString` must match uniquely),
  applied atomically — far more reliable than unified diffs for LLMs.
  When `apply_patch` contains **more than one edit**, the permission prompt
  offers per-hunk selection (approve/reject individual hunks in the CLI, TUI
  checkboxes, or desktop modal). Single-edit calls stay all-or-nothing.
- **Context manager** keeps long sessions inside the model window:
  micro-compaction clears old tool outputs first, then the middle is folded
  into a digest — mechanically, or by the model with `"compaction": "llm"`
  (falls back to the digest on failure). The prompt prefix stays stable to
  hit DeepSeek context caching (cache-hit input is ~10x cheaper; the CLI
  shows your hit rate).
- **DeepSeek V4 thinking**: `deepseek-v4-flash` / `deepseek-v4-pro` combine
  reasoning with tool calling — control it via `/think on|off|high|max` or
  the `thinking` / `reasoningEffort` config keys; streamed reasoning renders
  as a collapsible thought block and is never echoed back into requests.
- **OS sandbox (opt-in)**: `"sandbox": "workspace-write" | "restricted"`
  wraps commands in seatbelt (macOS) / bwrap (Linux); `restricted` also cuts
  network. Hard-fails if requested but unavailable — never silently
  unsandboxed. A denial-looking failure asks once before retrying unsandboxed.
- **Hooks** fire at 9 stages (preToolUse, postToolUse, sessionStart,
  userPromptSubmit, preCompact, stop, subagentStop, notification,
  sessionEnd); userPromptSubmit stdout is injected into the task as context,
  and preToolUse can block a tool with a reason or allow it outright.
- **MCP client** speaks stdio and streamable HTTP (`url` + optional bearer
  `headers`); server resources are listable and `@mcp:<server>:<uri>` inlines
  one into a message. SeekForge can also run *as* an MCP server
  (`seekforge mcp-serve`). Full guide: [docs/mcp.md](docs/mcp.md).
- **`ask_user`**: the agent can ask you a multiple-choice question mid-run
  (never available to subagents or backgrounded runs, so they can't block).
- **Skills** are procedure briefs (never permissions) selected per task by
  rule matching; ship your own in `.seekforge/skills/<id>/`.
- **Subagents** (builtin `explorer`/`reviewer`, plus `AGENT.md` in
  `.seekforge/agents/<id>/` or imported Claude/Meta_Kim-style definitions)
  let the main agent delegate bounded sub-tasks via `dispatch_agent` —
  in parallel within a turn, in the background (`agent_result` to poll),
  and resumable afterwards (`agent_send`). Each runs with its own prompt,
  tool whitelist, optional model, and turn budget; governance/review agents
  are read-only. A read-only (`ask`/`--plan`) session cannot dispatch an
  edit agent.
- **Permission rules**: `permissionRules` in config add allow/deny entries
  per tool with command/path prefixes; deny always wins. Rules files merge
  from `~/.seekforge/AGENTS.md` → `AGENTS.md` → `AGENTS.local.md`.
- **Memory**: after each edit session one extra model call distills durable
  facts as *candidates*; nothing enters long-term memory (`.seekforge/memory/project.md`)
  until you `seekforge memory approve` it. Relevant memory is injected into
  later sessions as a short brief, and the agent can pull more on demand with
  the read-only `search_memory` tool. Inspect extraction quality with
  `seekforge memory stats`; set `memoryAutoApproveConfidence` to auto-approve
  high-confidence facts.
- **Sessions** are JSONL traces under `.seekforge/sessions/<id>/` —
  messages, tool calls, and events are fully auditable.

## Security model

- 5 permission levels: readonly auto-runs; writes ask (unless `-y`);
  non-allowlisted commands ask; dependency installs always ask;
  dangerous commands (`rm -rf`, `sudo`, `git push`, pipe-to-shell, `bash -c`…)
  are always refused.
- Permission prompts show the **raw command/path**, never a model paraphrase.
  For `apply_patch` with multiple edits, a per-hunk preview is shown and you
  can approve/reject individual edits (CLI: `Pick hunks (e.g. 0,2)`;
  TUI/desktop: per-hunk checkboxes). Single-edit calls stay all-or-nothing.
- Workspace sandbox (realpath containment, symlink-escape checks);
  `.env`/`*.pem`/SSH keys are unreadable; secrets are redacted from output.
- Tool results are treated as data, not instructions (prompt-injection defense),
  and memory candidates are filtered and human-reviewed before persisting.

By default this is **misuse protection within a project you already trust** —
any project command (e.g. `npm test`) runs that project's code. For OS-level
isolation, opt into the sandbox (`"sandbox": "workspace-write" | "restricted"`,
seatbelt/bwrap; see above).

## Rust execution backend (optional)

The TypeScript dispatcher can delegate file/command/git execution to a small
trusted Rust binary that re-checks containment and the command denylist
(defense in depth). Permission decisions always stay in TypeScript.

```bash
cargo build --release
seekforge config set runtimeBin target/release/seekforge-runtime
```

Protocol: [`crates/runtime/PROTOCOL.md`](crates/runtime/PROTOCOL.md).

## Known limitations

- `deepseek-reasoner` is not usable as the agent model (no function calling;
  a fallback text protocol exists in the provider but is not wired into the
  loop). Use the DeepSeek V4 models instead — they combine thinking with
  tool calling.
- macOS / Linux only.

## Monorepo layout

```txt
apps/cli              the seekforge CLI (published to npm)
apps/tui              seekforge-tui — Ink terminal UI (ships in the npm package)
apps/server           seekforge serve — local agent server + web workbench
apps/desktop          Tauri desktop shell
packages/core         agent loop, provider, tools, memory, skills, runtime client
packages/shared       cross-cutting plain types
packages/eval-harness evaluation runner (pnpm eval)
crates/runtime        seekforge-runtime (Rust execution backend)
evals/                eval tasks, fixtures, baseline
examples/             fixture projects for end-to-end verification
```

Development: `pnpm install`, `pnpm typecheck`, `pnpm test` (TS),
`cargo test` (Rust). Conventions live in [AGENTS.md](AGENTS.md).

## Disclaimer

SeekForge is an independent project and is **not affiliated with, endorsed by,
or sponsored by DeepSeek**. "DeepSeek" is referenced only to indicate the
underlying model API used by this tool.

## License

[MIT](./LICENSE)

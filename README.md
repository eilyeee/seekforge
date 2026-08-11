# SeekForge

> **English** | [简体中文](README.zh-CN.md)

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
→ run_tests {}
✓ run_tests  5 passed
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
and an evaluation harness are in. Desktop starts without a blocking folder
dialog, restores recent projects, and folds long chats into per-task blocks.

✅ **Step 3 — unattended work** (1.0.0): autonomous Loop runs a task to green
under budget and verification guardrails; Graph Engineering composes Agent,
Loop, function, router and gate nodes with durable checkpoints and evidence;
a VS Code client joins the CLI, TUI, web, and desktop surfaces. See
[docs/roadmap.md](docs/roadmap.md) for capability maturity and priorities.

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
| `seekforge chat` | interactive session — the default when no command is given (`-p` for headless print mode) |
| `seekforge resume <session-id> [task]` | continue a session with its full history (keeps its ask/edit mode) |
| `seekforge sessions` | list sessions with status and cost (subagent runs hidden) |
| `seekforge sessions prune [--older-than <days>] [--keep-last <n>] [--dry-run]` | delete old session traces to keep `.seekforge/sessions/` bounded |
| `seekforge rewind [session-id] [--dry-run]` | undo all file changes a session made (pre-write checkpoints) |
| `seekforge replay <session-id>` | re-render a stored session to the terminal (deterministic, no model calls) |
| `seekforge audit <session-id> [--json] [-o <file>]` | export a reviewable report of what an agent did in a stored session |
| `seekforge memory add "<fact>" [--type] [--pending]` / `seekforge memory remove <n\|id\|text>` | tell the agent something directly (REPL: `/remember <fact>`) |
| `seekforge status` | project / config / last-session overview |
| `seekforge update` | check npm for a newer seekforge version and print the install command |
| `seekforge diff` | show the current git diff |
| `seekforge doctor` | run environment diagnostics (api key, node, git, runtime, mcp, editor, clipboard) |
| `seekforge resolve <issue> --max-cost <usd>` | fix a GitHub issue in an isolated worktree and open a draft PR; supports `--wait-ci` and `--dry-run` — see [GitHub workflow](docs/github.md) |
| `seekforge resolve-review <pr> --max-cost <usd>` | address actionable PR review feedback, verify, commit, and push fixes |
| `seekforge schedule add\|list\|run\|next\|history\|install\|uninstall\|status` | manage scheduled jobs, history, retries, and the crontab tick — see [Scheduling](docs/scheduling.md) |
| `seekforge loop "<task>" --verify "<cmd>"` | **engineering loop**: iterate until the verify command exits 0, with a durable checkpoint after every iteration; `--auto-verify` freezes a pipeline discovered from the project's manifests — see [Loop Engineering](docs/loop-engineering.md) |
| `seekforge loop-list\|loop-show\|loop-history\|loop-delete\|loop-prune\|loop-cleanup` | inspect persisted Loops and retained Loop worktrees, replay their bounded event history as JSONL, and retire the ones you are done with |
| `seekforge loop-resume\|loop-pause\|loop-continue\|loop-steer\|loop-recover\|loop-priority\|loop-deliver` | drive a Loop from another process: continue an interrupted run, pause and resume at the next safe boundary, queue guidance, re-arm orphaned runs for recovery, and deliver a passed result |
| `seekforge loop-diagnose\|loop-health\|loop-intelligence\|loop-evidence` | check a checkpoint against its retained history, forecast budget and verifier reliability, review cross-run anomalies, and export or verify requirement/verification/delivery evidence |
| `seekforge loop-speculate\|loop-speculation-list\|loop-speculation-promote` | run 2–3 isolated candidate repair strategies, rank the ones that pass, and merge the winning worktree into the current branch |
| `seekforge loop-dag <file>` / `seekforge loop-dag-resources` | **deprecated** — the flat Loop DAG engine still runs and still resumes existing checkpoints, but new work belongs in `seekforge graph`; migrate with `seekforge loop-dag export-graph` and see the [deprecation window](docs/loop-engineering.md#loop-dag-deprecation-window) |
| `seekforge orchestration report\|proposals\|policy\|index\|rollout\|controller\|maintain` | inspect and explicitly review cross-Loop and Graph decision intelligence; `maintain` freezes the controller and `controller resume` releases it |
| `seekforge graph validate\|run\|resume\|list\|show\|history\|delete` | run durable heterogeneous Agent/Loop/function/router/gate/subgraph workflows — see [Graph Engineering](docs/graph-engineering.md) |
| `seekforge graph pause\|continue\|steer\|cancel-node\|reprioritize\|signal` | control a live Graph from another process: safe-boundary pause/resume, guidance, pending-node cancel/reorder, and declared external signals |
| `seekforge graph evidence\|compare\|template` | export a tamper-evident Graph report, diff the current run against an archived one, or manage the versioned template registry (`template list\|show\|register\|compare\|deprecate`) |
| `seekforge sandbox-run "<task>"` | run a task through the Docker runner contract — see [Remote execution](docs/remote.md) |
| `seekforge remote-run "<task>" --host <user@host> --workspace <path>` | run the same task on a machine you own over ssh; that host uses its own API key — see [Remote execution](docs/remote.md) |
| `seekforge evolve analyze\|list\|show\|accept\|reject\|apply` | score sessions and review self-evolution proposals (human-gated) |
| `seekforge security scan\|list\|show\|status\|fix\|verify\|threat-model\|export` | deep repository security review, Finding queue/lifecycle, verified remediation, threat modeling, and JSON/Markdown/SARIF evidence export — see [Security scanning](docs/security-scanning.md) |
| `seekforge init` | scaffold `.seekforge/` and an `AGENTS.md` template |
| `seekforge mcp add\|list\|remove <name>` | manage MCP servers in config (list, add a stdio server, or remove) — see [docs/mcp.md](docs/mcp.md) |
| `seekforge mcp login\|logout <name>` | authorize a remote MCP server interactively (OAuth 2.1 + PKCE), or forget its stored credential |
| `seekforge mcp-serve [--allow-write]` | run SeekForge as an MCP server on stdio (read-only tool set by default); `--allow-write` exposes write tools (TRUSTED callers only) |
| `seekforge skill list\|show\|create\|enable\|disable <id>` | procedure skills (project > global > builtin); enable/disable toggles a skill |
| `seekforge skill import <path> [-g] [-f]` | import a Claude-style SKILL.md (YAML frontmatter) as a project or global skill |
| `seekforge plugin list\|create\|install\|update\|rollback\|supply-chain\|enable\|disable\|remove` | manage first-class extension bundles; installs stay disabled until their exact digest is approved, `rollback` restores the previous version and `supply-chain` reports integrity and rollback availability — see [docs/plugins.md](docs/plugins.md) |
| `seekforge agent list\|show <id>\|import <path>` | manage subagents; the main agent delegates bounded sub-tasks via `dispatch_agent` |
| `seekforge memory list\|approve <id>\|reject <id>` | review extracted facts into long-term project memory |
| `seekforge memory compact [--dry-run] [--prune-unused <days>]` | collapse duplicate and near-duplicate facts in project.md (deterministic); `--prune-unused` requires a non-negative integer and archives never-used facts older than `<days>` to `project-archive.md` |
| `seekforge memory keywords [--dry-run] [--limit <n>]` | give bilingual retrieval keywords to facts that have none, so a question asked in one language reaches an answer written in the other; the only memory command that calls the model (`--dry-run` just counts) |
| `seekforge memory stats` | print memory extraction-quality stats — approved/pending/rejected counts, used fraction, rejection rate (read-only); inspect this before tuning `memoryAutoApproveConfidence` |
| `seekforge config show\|set <key> <value> [-g]` | `set` accepts: `apiKey`, `model`, `baseUrl`, `provider`, `runtimeBin`, `commandAllowlist`, `sandbox`, `thinking` / `reasoningEffort`, `compaction`. Server/Desktop also manage the selectable `models` list. Structured keys (`permissionRules`, `hooks`, `mcpServers`, `planModel`) are **edited directly in `.seekforge/config.json`** — not via CLI `config set`. Config layers: env vars > CLI flags > [`--settings <file>`](docs/cli-reference.md#settings-layering) > personal `.seekforge/config.local.json` > project `.seekforge/config.json` > global `~/.seekforge/config.json`. Full reference: [docs/configuration.md](docs/configuration.md) |

VS Code users can run the thin local extension in
[`apps/vscode`](apps/vscode/README.md). It reuses `seekforge serve` for tasks,
session resume, permission prompts, questions, diff viewing, and active-file context.

Headless single-run via `seekforge -p "<prompt>"` accepts the same flags as
`seekforge run` plus `--ask`, `--input-format` (text | stream-json),
[see the full list](docs/cli-reference.md).

`Ctrl+C` cancels a running session cooperatively (the trace is kept, so
`seekforge resume` can pick it up); a second `Ctrl+C` force-quits.
`@path` tokens in a task inline that file's content (sensitive files excluded).
The agent can also: publish a live plan checklist (`update_plan`), run the
project's tests and get back which ones failed rather than a wall of output
(`run_tests`), read the history behind the code (`git_log` / `git_blame` /
`git_show`), work on Jupyter notebooks as cells rather than JSON
(`notebook_read` / `notebook_edit`), commit its work
(`git_commit`; a `git push` is confirmed every single time and a force-push is
refused outright), and fetch public docs pages (`web_fetch` — every URL needs
explicit confirmation; private addresses refused).

## Desktop workbench

`seekforge serve` opens a local, token-protected web workbench (React) — on
`127.0.0.1` only — that the Tauri shell wraps as a native macOS app. It drives
the **same** agent/API as the CLI, in a light, Codex-style UI (dark mode opt-in;
language follows en / zh-CN), with every surface in one window:

- **Chat** — multi-tab sessions with a home screen (quick-action starters +
  recent sessions/skills/agents), streaming tool-run and subagent cards with
  targeted guidance/cancellation, per-hunk diff
  approval, plan execution, and a composer with `@` file mentions, `/` commands,
  image attach/paste, and a thinking toggle.
- **Sessions · Changes · Skills · Subagents · Memory · Evolution · Settings** —
  resume sessions, review the working-tree diff, toggle skills, inspect
  subagents, approve memory candidates, gate self-evolution proposals, and edit
  config (model list, sandbox, theme, language…).
- **Todos** — a side panel backed by `.seekforge/todos.md`.

```bash
seekforge serve                                     # open the printed URL in a browser
seekforge serve --loop-auto-resume                  # also resume interrupted Loops while idle (opt-in)
seekforge serve --loop-auto-prune                   # prune old terminal Loops while idle (opt-in)
pnpm --filter @seekforge/desktop build && pnpm tauri dev   # or the native app (dev)
```

The bundled DMG app is self-contained — it embeds the server as a sidecar, so a
user who installs only the bundle needs **no** system `seekforge`. In `tauri dev`
(no bundle) it falls back to a `seekforge` on PATH or the repo's tsx runner. See
[apps/desktop/src-tauri/README.md](apps/desktop/src-tauri/README.md).

## Continuous Agent Eval

The eval harness supports versioned smoke/nightly/release suites, bounded
multi-sample runs, deterministic task checks, task-level regression comparison,
quality/cost/token/reliability gates, run metadata, and Markdown/JSON/JUnit
reports. The weekly workflow runs the nightly suite against the committed
baseline; see [Evals and the regression gate](docs/EVALS.md).

## How it works

- **Code navigation** for large repos: `repo_map` gives a compact structural
  overview (auto-injected for big repos) and `find_definition` jumps to where a
  symbol is defined. Symbol extraction is hybrid — tree-sitter (accurate, for
  JS/TS, Python, Java, Rust, Go, C/C++, C#) with a dependency-free regex floor
  for everything else; tree-sitter ships as an **optional** dependency.
- **Task-relevant retrieval**: at session start the loop also injects a shortlist
  of files ranked by how well their path/exports match *this* task (CJK-aware) —
  a starting point that complements the generic overview and `search_text`.
- **Verify & review on finish (opt-in)**: with `verifyCommand` set, the loop
  auto-runs it on completion and feeds failures back to fix; with `finalizeReview`
  on, it dispatches a read-only **reviewer** subagent over the diff.
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
- **OS sandbox (opt-in)**: `"sandbox": "read-only" | "workspace-write" | "restricted"`
  wraps commands in seatbelt (macOS) / bwrap (Linux); `read-only` protects the
  workspace and `restricted` also cuts network. Hard-fails if requested but unavailable — never silently
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
- **Subagents** (five builtins — `explorer`, `reviewer`, `planner`,
  `test-writer`, `debugger` — plus `AGENT.md` in
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
  high-confidence facts. Optional user-owned `memoryMaintenance` automatically
  compacts approved facts after count/size thresholds and can archive never-used
  stale facts; long-lived Server/Desktop, TUI, and REPL processes schedule it
  only while idle. It is deterministic, interval-limited, and disabled by default.
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
isolation, opt into the sandbox (`"sandbox": "read-only" | "workspace-write" | "restricted"`,
seatbelt/bwrap; see above).

## Rust execution backend (optional)

The TypeScript dispatcher can delegate file/command/git execution to a small
trusted Rust binary that re-checks containment and the command denylist
(defense in depth). Permission decisions always stay in TypeScript.

```bash
cargo build --release
seekforge config set runtimeBin target/release/seekforge-runtime --global
```

Protocol: [`crates/runtime/PROTOCOL.md`](crates/runtime/PROTOCOL.md).

## Known limitations

- `deepseek-reasoner` is not usable as the agent model: it has no function
  calling, and SeekForge deliberately ships no text-protocol fallback that would
  parse tool calls out of model prose — assistant text and tool output are the
  same untrusted channel, so a fenced block inside a file or diff would become
  an executed call. Use the DeepSeek V4 models instead — they combine thinking
  with tool calling.
- Shell command execution is POSIX-only: `run_command`, background tasks, and
  the Rust runtime all execute through `/bin/sh -c`, so the command tools do not
  run on native Windows — use WSL. Native Desktop packages target macOS, Linux,
  and Windows, but Windows appears in CI only as a Desktop packaging target, not
  as a tested runtime.
- The optional OS command sandbox supports macOS (seatbelt) and Linux (bwrap)
  only, and no Windows equivalent is planned: job objects and restricted tokens
  cannot express a deny-by-default *path* policy, and AppContainer can only reach
  files whose ACLs name its package SID — which would break the reads every build
  needs and block loopback even at the levels meant to leave the network alone.
  Requesting a sandbox on Windows fails closed rather than shipping a weaker
  guarantee under the same name.

## Monorepo layout

```txt
apps/cli              the seekforge CLI (published to npm)
apps/tui              seekforge-tui — Ink terminal UI (ships in the npm package)
apps/server           seekforge serve — local agent server + web workbench
apps/desktop          Tauri desktop shell
apps/vscode           thin VS Code client over seekforge serve
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

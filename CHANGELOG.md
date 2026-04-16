# Changelog

## 0.7.0 (unreleased)

TUI v2 — full-parity terminal UI (apps/tui/DESIGN.md batches A–D).

### Added
- Input & navigation: typing `/` opens a fuzzy command palette (↑↓/Tab/Enter,
  argument hints); typing `@` opens a frecency-ranked fuzzy file picker over
  the workspace; multiline composer (trailing `\` or Ctrl+J for newlines,
  ↑/↓ history persisted to `.seekforge/tui-history`, Ctrl+U clear, Esc clears
  or cancels); managed scrollback viewport (PageUp/PageDown, Esc jumps to
  latest, older items virtualized).
- Review & modes: inline colored diffs after `apply_patch`/`write_file`
  (before/after captured around the tool call, unified hunks, collapsible);
  `/plan <task>` runs a read-only planning turn then asks `y` to execute in
  the same session; persistent approval modes auto / confirm / plan
  (Shift+Tab cycles, `/approve` sets); the permission panel gains
  `a` = allow similar commands for this session (feeds the live allowlist,
  applies mid-run); `/rewind [yes]` dry-runs/undoes the session's file edits.
- Sessions, memory, surfaces: `/sessions` + `/resume <id>`;
  `# <fact>` / `/remember` write straight to project memory; background
  tasks surface as `⚙ N bg` in the status bar and `/tasks`; `/context`
  opens a context inspector overlay (gauge, tokens, usage, items);
  `/agents` and `/mcp` list what's dispatchable; nested subagent activity
  renders as indented `↳ [agent] tool` rows.
- Polish: syntax-highlighted fenced code blocks (built-in tokenizer for
  ts/js/py/rust/go/sh/json/css/html/yaml — no new deps); configurable accent
  color (`accent` in config or `SEEKFORGE_TUI_ACCENT`; `NO_COLOR` respected);
  Ctrl+G / `/editor` edits the prompt in `$EDITOR`; `/copy` copies the last
  reply to the clipboard.

- Steering & shell: the composer stays live during a run — Enter queues
  follow-ups (sent in order afterwards; Esc cancels run + queue); `!cmd`
  runs a local shell command directly with inline output; terminal bell on
  permission prompts and completion (`"bell": false` in config disables).
- `/clear` (reset transcript + session), `/diff` (colored git diff of the
  working tree), `/export [path]` (transcript → markdown), `/memory [edit]`
  (list project facts / open in $EDITOR); `/sessions` is now an interactive
  picker (↑↓ + Enter resumes).
- Manual `/compact`: core gains `compactSessionNow(workspace, sessionId)` —
  folds the middle of a stored session's messages.jsonl into a digest on
  demand (the next message resumes the compacted history).
- Background tasks now survive across turns: `createAgentCore` accepts a
  shared caller-owned `background` manager (the TUI passes one per process,
  killed on exit); `/tasks` shows live status and `/tasks kill <id>` stops
  one.

### Changed
- TUI keybindings are a declarative testable table (`keymap.ts`); all input
  routing (permission → overlay → composer) is centralized in one handler.
- TUI tests: 26 → 172 (editor model, history, fuzzy, file index, viewport,
  diff, capture, allowlist, surfaces, highlight, theme, keymap, export).

## 0.6.0 (unreleased)

Phase 8 batch 5 — terminal UI and multi-project.

### Added
- `seekforge-tui`: an Ink (React-for-terminal) chat UI — scrolling transcript
  with streamed markdown, tool rows, in-place plan checklist, file badges and
  a final report; bottom composer with a status bar (model, context %, cost,
  working spinner); inline permission panel showing the raw command/path;
  slash commands (/help /new /model /context /usage /quit), @path inlining,
  Ctrl+C cancel. Runs AgentCore in-process (no server).
- Multi-project: one `seekforge serve [paths...] [--workspace <p>]` hosts
  several workspaces; `GET /api/workspaces`, a `?ws=<id>` param on all scoped
  routes (default = first, back-compatible), and a `ws` field on WS start/send.
  The web workbench gains a workspace switcher; each tab binds to its own
  workspace.

## 0.5.0 (unreleased)

Phase 8 batch 4 — final harness pieces.

### Added
- Tool-call hooks (`hooks.preToolUse/postToolUse/sessionEnd` in config):
  shell commands fired around tools; a non-zero preToolUse hook BLOCKS the
  tool (e.g. a lint gate). Payload on stdin, never the command line.
- Context-window visibility: `context.usage` event; the CLI shows `· ctx N%`
  and `/context` in the REPL; the web footer shows occupancy (amber/red).
- `web_search` tool (keyless DuckDuckGo HTML; network, always confirmed).
- `seekforge skill enable|disable|remove <id>` (builtins disable via marker).
- `seekforge memory compact [--dry-run]`: deterministic dedup/merge of
  project.md facts (CJK tokenized per character).

## 0.4.0 (unreleased)

Phase 8 batches 1–3 — harness ergonomics and the desktop workbench.

### Added (batch 3)
- Desktop workbench: multi-session tabs (each tab its own WebSocket session,
  parallel runs), Plan/Ask/Edit mode selector with an "Execute plan" step,
  auto-approve toggle, system notifications when hidden (confirmation needed /
  task finished), Agents and Evolution management views, an MCP panel in
  Settings, and per-session Rewind with dry-run preview.
- Server: /api/agents, /api/evolution (accept/reject/apply), /api/mcp
  (config + on-demand tool listing; env values never serialized), /api/rewind;
  WS start accepts plan, send accepts a mode override.

### Added (batch 2)
- Subagent execution upgrade: multiple `dispatch_agent` calls in one turn
  run in parallel; `background: true` + `agent_result` polling;
  `agent_send` continues a completed subagent with its context; builtin
  read-only `explorer`/`reviewer` agents; per-agent `model:` in AGENT.md.
- Fine-grained permission rules (`permissionRules` config): allow/deny per
  tool with command/path prefix match — deny blocks everything (even with
  `-y`), allow skips prompts but never rescues dangerous commands or
  bypasses read-only mode.
- Rules-file hierarchy: `~/.seekforge/AGENTS.md` (all projects) +
  `AGENTS.md` + `AGENTS.local.md` (personal, gitignore it) merged into the
  system prompt with origin headers.

### Added (batch 1)
- Background tasks: `run_command` accepts `background: true` (dev servers,
  watchers) plus `task_output` / `task_kill` tools; ring-buffered output,
  same permission flow as foreground, every task killed at session end.
- Checkpoint & rewind: file contents are snapshotted before a session's
  first write to each path (incl. the Rust backend path); `seekforge rewind
  [session] [--dry-run]` restores originals and deletes created files.
- Direct memory channel: `seekforge memory add` (straight into project.md
  with an audit candidate, `--pending` to queue instead), `memory remove`
  by index/id/text, numbered `memory list`, and `/remember <fact>` in the
  REPL. Injection-filtered like extracted memories.

## 0.3.0 (unreleased)

Phase 4 — interactive surfaces.

### Added
- Web workbench Diff view: per-file grouped, collapsible workspace diff with
  +/- stats and staged toggle, backed by GET /api/diff.
- `seekforge sessions prune --older-than <days> / --keep-last <n> [--dry-run]`
  to bound `.seekforge/sessions/`. Subagent (dispatched) sessions are now
  tagged with their parent agent, hidden from `sessions`/`status` and skipped
  by `evolve analyze`, and pruned along with their parent's age.
- Subagents: `AGENT.md` definitions (project > global), `seekforge agent
  list|show|import`, and a `dispatch_agent` tool the main agent uses to
  delegate bounded sub-tasks (own prompt, tool whitelist, turn budget,
  depth guard). Governance/review agents are read-only; a read-only
  (ask/plan) session cannot dispatch an edit agent. Imports Claude-style
  agent definitions incl. Meta_Kim's meta-agents (tool mapping + mode
  inference). The web workbench shows nested subagent activity.
- Evaluation harness (`packages/eval-harness`, `evals/`): four deterministic
  tasks with fixtures, `pnpm eval` runner, markdown/JSON reports, and
  baseline comparison for regression tracking.
- Plan mode: `seekforge run --plan` and `/plan <task>` in the REPL —
  read-only investigation produces a concrete plan; after your confirmation
  the SAME session executes it. Resumed sessions now rebuild their system
  prompt, so mode switches apply and freshly approved memory takes effect
  (fixes the stale-prompt limitation).
- `seekforge skill import <path> [--global] [--force]`: import external
  Claude-style SKILL.md skills (YAML frontmatter; |-separated triggers,
  block-scalar descriptions — e.g. Meta_Kim canonical skills). Imported
  skills are enabled with medium trust and never grant permissions.
- Interactive REPL as the default command (`seekforge`): multi-turn sessions
  with slash commands (/new /sessions /resume /model /usage)
- `seekforge serve`: local agent server (127.0.0.1, token-protected) with a
  REST API, a WebSocket session protocol (streaming deltas, permission
  round-trips, cancel), and a bundled React web workbench: chat with live
  plan/tool rows and a raw-args permission modal, sessions browser, skills,
  memory review, settings

## 0.2.0 (unreleased)

Gap-fill iteration after comparing against Claude Code / Codex CLI.

### Added
- `git_commit` tool (stages + commits; pushing remains impossible)
- `web_fetch` tool: public http(s) pages as readable text — always asks for
  confirmation, refuses private/loopback addresses (SSRF guard)
- `update_plan` tool: live step checklist rendered in the terminal
- `--json` flag on `run`/`ask`: one JSON event per line for CI use
- `@path` tokens in tasks inline file contents (sensitive files excluded)
- `commandAllowlist` config key (comma-separated command prefixes that
  auto-run without confirmation) — the policy engine already supported it,
  now it is configurable

## 0.1.0 (unreleased)

First usable release of the SeekForge CLI.

### Added
- Agent loop with turn/tool-call limits, context compaction, JSONL session
  traces, token/cost tracking (DeepSeek context-cache aware)
- DeepSeek provider: streaming (SSE), tool calls, retries, cost estimation,
  fallback text-protocol parser (not yet wired into the loop)
- Tool system: 10 sandboxed tools, 5-level permission policy, search/replace
  edit engine, command classification with denylist, secret redaction
- CLI: `run`, `ask`, `resume`, `sessions`, `status`, `diff`, `init`,
  `skill list|show|create`, `memory list|approve|reject`, `config show|set`;
  streaming output; cooperative Ctrl+C cancellation
- Skills: 3 builtin skills, project/global layers, rule-based selector,
  usage logging
- Memory: post-task fact extraction with human review (candidates →
  `project.md`), task-relevant memory brief injection
- Rust execution backend (`seekforge-runtime`): stdio JSONL protocol,
  workspace sandbox, atomic edits, process-group command timeouts —
  enabled via `config set runtimeBin <path>`

### Fixed
- Memory injection filter no longer drops legitimate facts containing
  "ignore" (e.g. `.gitignore` conventions)
- `init` creates `config.json` with 0600
- `--model deepseek-reasoner` is refused upfront instead of failing midway
- Ctrl+C during a permission prompt now denies and cancels cleanly

## 0.0.1 (2026-06-10)

npm placeholder release to reserve the package name.

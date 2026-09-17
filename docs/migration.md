# Migrating from Aider / Cline / Claude Code / Codex

> **English** | [简体中文](migration.zh-CN.md)

A factual mapping of concepts from other coding agents to their SeekForge
equivalents. This is not a claim of parity — it's a lookup table so you can find
the SeekForge feature you already know from another tool.

## Concept mapping

| Their concept | SeekForge equivalent |
| --- | --- |
| Edit format (unified diff / search-replace / whole-file) | `apply_patch` — verbatim search/replace edits applied atomically; `write_file` for new files or full rewrites. |
| Model setting (`--model`, `model:` in config) | `model` config key + `--model`/`-m` flag; `provider` selects the endpoint preset; `modelPricing` supplies per-model costs. |
| Config file (`.aider.conf.yml`, `.clinerules`, `settings.json`, `config.toml`) | `.seekforge/config.json` (project) + `~/.seekforge/config.json` (global) + `.seekforge/config.local.json` (gitignored). See [Configuration](configuration.md). |
| API key env var | `DEEPSEEK_API_KEY` (or `ARK_API_KEY` for the Ark provider); also the `apiKey` config key. |
| Project instructions (`CONVENTIONS.md`, `.clinerules`, `CLAUDE.md`, `AGENTS.md`) | `AGENTS.md` (created by `seekforge init`), plus curated `.seekforge/memory/project.md` memory. Claude Code's `CLAUDE.md` files are read too — see [below](#coming-from-claude-code). |
| Path-scoped rules (`.claude/rules/*.md` with `paths:`) | `.seekforge/rules/**/*.md` with the same `paths:` frontmatter; `.claude/rules/` is read as well. |
| `@path` imports in instruction files | Supported in every rules file; project files may only import inside the workspace. |
| MCP servers (`claude mcp add`, `.mcp.json`) | `mcpServers` config + `seekforge mcp add/add-json/list/get/remove`; a project `.mcp.json` is read (each server needs `seekforge mcp approve`), and `seekforge mcp import` copies Claude Desktop / Claude Code servers. See [MCP](mcp.md). |
| Slash commands / custom commands | Built-in slash commands + custom commands under `.seekforge/commands/`. `description:` frontmatter and `$ARGUMENTS` work on every surface; `` !`shell` `` interpolation is expanded by the CLI REPL (`seekforge` with no command) and the server, **not** by the TUI. See the [TUI README](../apps/tui/README.md#custom-commands) for the file format. |
| Subagents / specialist agents | `dispatch_agent` roster — `seekforge agent list/show/import`, definitions under `.seekforge/agents/`. Claude Code's `.claude/agents/*.md` (project and `~/.claude/agents/`) load in place, with tool names mapped and repository files restricted to tightening. See [Subagents](subagents.md). |
| Skills / reusable procedures | `.seekforge/skills/<id>/SKILL.md` — `seekforge skill create/list/import`. |
| Session history / transcripts | Session traces under `.seekforge/` — `seekforge sessions`, `resume`, `replay`, `audit`. |
| Permission / approval modes (auto-approve, plan mode) | Approval modes `auto` / `acceptEdits` / `confirm` / `manual`; `-y`, `--permission-mode`, `permissionRules`. Plan mode is not an approval mode — `--plan` (or `--permission-mode plan`) runs read-only under `confirm`. |
| Cost / token tracking | Built-in for DeepSeek; `modelPricing` + `maxCostUsd` budget for other providers; `seekforge models`, TUI `/usage`. |
| Headless / scripting mode | `seekforge -p "<prompt>"` with `--output-format json|stream-json`. See [CLI reference](cli-reference.md). |

## Coming from Claude Code

Your instruction files keep working without changes:

- `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` load next to
  `AGENTS.md` / `AGENTS.local.md` (the `AGENTS` file of each tier first;
  identical content once, so a `CLAUDE.md` symlinked to or importing
  `AGENTS.md` is not duplicated).
- A subdirectory's `CLAUDE.md` loads the first time the agent reads or edits a
  file below it, as a subdirectory `AGENTS.md` does.
- `.claude/rules/**/*.md` loads like `.seekforge/rules/`: always without
  `paths:`, on the first matching file with it.
- `~/.claude/CLAUDE.md` is read only if you opt in with
  `"claudeCompat": "all"` in `~/.seekforge/config.json`; `"off"` stops reading
  Claude files altogether. A repository cannot change this setting.
- Imports differ in one way: a project file cannot import `@~/…` or anything
  outside the workspace. Move such content into `~/.seekforge/AGENTS.md` or
  `~/.claude/CLAUDE.md`, where home-directory imports work.

The edit tools follow the same discipline as Claude Code's: the agent must read
a file in the session before changing it, and re-read it after it changed on
disk. See [Configuration → Project rules](configuration.md#project-rules) and
[File tools](configuration.md#file-tools).

## What's distinctive about SeekForge

- **Local-first.** Sessions, memory, skills, and config all live under
  `.seekforge/` in your project (or `~/.seekforge/`). Nothing is uploaded; the
  desktop/web server binds to `127.0.0.1` only.
- **DeepSeek-native, provider-flexible.** Ships tuned for DeepSeek V4 (thinking
  mode, context caching, built-in pricing/balance) but talks to any
  OpenAI-compatible endpoint via provider presets (`ark`, `openai`, `ollama`, …)
  with `modelPricing` for cost.
- **Deterministic session audit.** `seekforge audit <session-id>` (and TUI
  `/audit`) produces a reviewable report — prompts, every tool call with a
  compacted args preview and outcome, files changed, cost — read straight from
  the on-disk trace with no model calls. `seekforge replay` re-renders a session;
  `seekforge rewind` undoes a session's file changes.
- **Layered permission boundaries.** A built-in permission policy plus
  fine-grained `permissionRules` (allow/deny by tool + match), an optional
  OS-level `sandbox` (`read-only` / `workspace-write` / `restricted`), a `commandAllowlist`,
  and shell `hooks` that can block tool calls.
- **Git worktree sessions.** `/worktree new` runs the agent on an isolated
  `git worktree` under `.seekforge/worktrees/` on a `seekforge/<slug>` branch,
  keeping your working tree untouched.
- **Human-gated memory.** Auto-extracted facts stay **pending** until you
  approve them (`seekforge memory approve`, TUI `/memory candidates`), unless you
  opt into `memoryAutoApproveConfidence`.
- **Autonomous verify loop.** `seekforge loop <task> --verify <cmd>` (TUI
  `/loop`) drives run→verify→continue until a shell command exits 0. See
  [Loop engineering](loop-engineering.md).

For hands-on recipes, see the [Cookbook](cookbook.md). To embed the engine, see
the [SDK guide](sdk.md).

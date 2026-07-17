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
| Project instructions (`CONVENTIONS.md`, `.clinerules`, `CLAUDE.md`, `AGENTS.md`) | `AGENTS.md` (created by `seekforge init`), plus curated `.seekforge/project.md` memory. |
| MCP servers | `mcpServers` config + `seekforge mcp add/list/remove`. See [MCP](mcp.md). |
| Slash commands / custom commands | Built-in TUI slash commands + custom commands (frontmatter, `$ARGUMENTS`, `` !`shell` ``). See the [TUI README](../apps/tui/README.md#custom-commands). |
| Subagents / specialist agents | `dispatch_agent` roster — `seekforge agent list/show/import`, definitions under `.seekforge/agents/`. |
| Skills / reusable procedures | `.seekforge/skills/<id>/SKILL.md` — `seekforge skill create/list/import`. |
| Session history / transcripts | Session traces under `.seekforge/` — `seekforge sessions`, `resume`, `replay`, `audit`. |
| Permission / approval modes (auto-approve, plan mode) | Approval modes `confirm` / `acceptEdits` / `auto` / `plan`; `-y`, `--permission-mode`, `--plan`, `permissionRules`. |
| Cost / token tracking | Built-in for DeepSeek; `modelPricing` + `maxCostUsd` budget for other providers; `seekforge models`, TUI `/usage`. |
| Headless / scripting mode | `seekforge -p "<prompt>"` with `--output-format json|stream-json`. See [CLI reference](cli-reference.md). |

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

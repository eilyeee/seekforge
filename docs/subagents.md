# Subagents

> **English** | [简体中文](subagents.zh-CN.md)

A subagent is a specialist the main agent delegates a bounded sub-task to. It
runs as a nested agent with its own prompt, tool set, turn budget and
approval mode, and returns one report. The main agent sees four synthetic
tools for this: `dispatch_agent`, `dispatch_team` (a dependency graph of
dispatches), `agent_result` (poll), and `agent_send` (continue a finished
dispatch). Dispatched agents see a fifth, `agent_report`, for progress lines
back to the parent. Dispatched runs never dispatch further.

Five agents ship built in: `explorer`, `reviewer` and `planner` (read-only),
`test-writer` and `debugger`. `seekforge agent list`, `seekforge agent show
<id>` and `seekforge agent import <path>` inspect and import definitions.

## Where definitions come from

Two file layouts are read, in this order (a later entry replaces an earlier
one with the same id):

| Order | Location | Scope |
| --- | --- | --- |
| 1 | built-in agents | builtin |
| 2 | `agentRoots` of enabled [plugins](plugins.md) | global |
| 3 | `~/.claude/agents/<name>.md` (Claude Code format) | global |
| 4 | `~/.seekforge/agents/<id>/AGENT.md` | global |
| 5 | `<workspace>/.claude/agents/<name>.md` (Claude Code format) | project |
| 6 | `<workspace>/.seekforge/agents/<id>/AGENT.md` | project |

So a project definition overrides a global one, and within one scope a
SeekForge `AGENT.md` wins over a Claude Code file with the same id. A Claude
Code file's id is its `name` field (kebab-cased), or its file name when the
field is missing. Symlinked files and directories are not followed, and a
definition larger than 256 KiB is skipped. A definition with invalid
frontmatter is skipped silently; `seekforge agent show <id>` tells you whether
it loaded.

`seekforge agent import <path>` converts a Claude Code or Meta_Kim-style file
into `.seekforge/agents/<id>/AGENT.md` (or the global root with `--global`).
An import is how a file of unknown origin becomes a definition you trust, so
it keeps only what tightens: `hooks` and a `permissionMode` of `acceptEdits`
or `bypassPermissions` are dropped. Add them to your own file by hand if you
want them.

## Frontmatter

Frontmatter is a YAML subset: scalars, quoted strings, `|` / `>` blocks,
lists (block `- item`, including items at the key's own column, and flow
`[a, b]`), and nested maps. Anchors, tags and multi-line flow collections are
not supported. Keys are case-insensitive at the top level.

| Field | Meaning |
| --- | --- |
| `name`, `description` | Display name and the one-liner the main agent picks from. |
| `trigger` | Dispatch hints: `a \| b` or a list. Informational. |
| `tools` | Tool whitelist (comma list or YAML list). Absent = every tool the parent has. An explicit empty list grants none. |
| `disallowedTools` | Tools removed after the whitelist is applied. |
| `mode` | `ask` (read-only) or `edit` (default). |
| `permissionMode` | Approval mode for the agent's own tool calls: `default` (confirm), `acceptEdits`, `bypassPermissions` (auto), `plan` (read-only, same as `mode: ask`), `dontAsk` (every prompt is answered "no"; only allow-listed calls run). `confirm`, `manual`, `auto` and `ask` are accepted as aliases. Absent = the parent's approval mode. |
| `isolation` | `worktree`: an edit agent works in its own git worktree (see below). |
| `skills` | Skill ids whose bodies are preloaded into the agent's prompt, in order, within 12,000 characters; a skill that does not fit points at `read_skill`. |
| `effort` | `low` (thinking off), `medium` / `high` (reasoning effort high), `max`. Applied where the provider supports thinking controls. |
| `color` | Display color for frontends: `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `cyan`, or `#rrggbb`. Anything else is ignored. |
| `mcpServers` | Names of MCP servers whose tools this agent may see. Only servers the host already connected (trusted in your config) exist to be named; an inline server definition is ignored. Absent = every connected server. |
| `hooks` | Agent-scoped hooks for `preToolUse`, `postToolUse` and `Stop` (runs as `subagentStop`). SeekForge entries (`match` / `pattern` / `command`) and Claude Code entries (`matcher` + `hooks: [{type: command, command}]`) both work. |
| `model` | Model override. Claude Code aliases (`sonnet`, `opus`, `haiku`, `inherit`) are ignored. |
| `max-turns` / `maxTurns` | Turn budget (default 15). |
| `own`, `do_not_touch`, `boundary` | Binding constraints rendered into the agent's prompt. |

An unknown `permissionMode` or `isolation` value makes the whole definition
invalid rather than running looser than written.

```markdown
---
name: fixer
description: Fixes a reported bug end to end
tools: [read_file, search_text, glob, apply_patch, run_tests]
permissionMode: acceptEdits
isolation: worktree
skills: [bugfix]
effort: high
color: green
---
Reproduce the failure first, then fix the smallest cause.
```

Claude Code tool names map as follows; names with no equivalent (`Task`,
`ExitPlanMode`, …) and scoped specifiers such as `Bash(git status:*)` are
dropped rather than widened:

| Claude Code | SeekForge |
| --- | --- |
| `Read` / `Write` | `read_file` / `write_file` |
| `Edit`, `MultiEdit` | `apply_patch` |
| `Glob` / `Grep` / `LS` | `glob` / `search_text` / `list_files` |
| `Bash`, `BashOutput`, `KillShell` | `run_command`, `task_output`, `task_kill` |
| `WebFetch` / `WebSearch` | `web_fetch` / `web_search` |
| `NotebookEdit` / `NotebookRead` | `notebook_edit` / `notebook_read` |
| `TodoWrite` | `update_plan` |
| `LSP` | the `lsp_*` tools |
| `mcp__server__tool` | unchanged |

## Trust

A definition's scope decides how much of it is honored:

- **Project** definitions (`.seekforge/agents/` and `.claude/agents/` in the
  repository) are repository-controlled. They may only tighten: a
  `permissionMode` looser than the parent run's approval mode is clamped to
  the parent's, and `hooks` are ignored.
- **Global** (your home directory), **plugin** (enabled against a reviewed
  digest) and **builtin** definitions get what they declare, including a
  looser `permissionMode` and hooks. When one runs with a declared approval
  mode, the dispatch prompt says so (`Dispatch agent fixer (approval mode
  auto): …`).
- In every scope, an agent's tools are a subset of what the parent run
  already has (its dispatcher and `allowedTools`), and `mcpServers` only
  filters servers the host connected.

See [Security model](security-model.md#subagent-definitions-and-reports).

## Dispatching

Read-only (`ask`) agents run in parallel and need no approval; they are the
only kind a read-only (`ask` / `--plan`) run may dispatch. An edit agent asks
for approval first unless the approval mode is `auto`.

Edit agents without isolation never write the same workspace at once: each
holds a per-workspace edit lock for its whole run, and a second one shows
`waiting for another edit agent to finish` until the first is done.
`dispatch_team` additionally runs at most one edit member at a time. The lock
is in-process; separate processes on one checkout are not coordinated.

With `background: true`, `dispatch_agent` returns a dispatch id at once; poll
it with `agent_result` and continue a finished one with `agent_send`.

## Isolated edit agents

`isolation: worktree` in the definition, or `isolation: "worktree"` in the
`dispatch_agent` call, runs an edit agent in a managed git worktree
(`.seekforge/worktrees/agent-<id>-<hex>` on branch `seekforge/agent-<id>-<hex>`)
created from the current commit. The agent does not see uncommitted changes
in your checkout. Isolation is ignored for read-only agents, and a workspace
that is not a git repository with at least one commit fails the dispatch with
`isolation_unavailable`.

When the agent finishes, its change (runtime state under `.seekforge/`
excluded) is reviewed like any other write:

1. Every changed path must pass the parent's own write rules — workspace
   containment and any `deny` / `ask` permission rule for `apply_patch` or
   `write_file`.
2. One approval request (`dispatch_agent`, or `agent_send`, at the `write`
   level) lists the files and carries the diff as its preview. The parent's
   approval mode decides as usual: `auto` and `acceptEdits` apply it without a
   prompt.
3. Under the edit lock, the patch is checked, then applied to the working tree
   (never the index). The parent records checkpoints first, so a rewind
   restores text files, and emits `file.changed` for each file.
4. The worktree and its branch are removed.

A worktree with no change is removed. A change that is denied, refused by a
rule, conflicts with your checkout, or comes from a failed or cancelled run is
committed to the worktree branch and kept. The dispatch result says what
happened:

```json
{ "isolation": { "status": "retained", "reason": "denied", "files": ["a.ts"],
  "worktree": "/repo/.seekforge/worktrees/agent-fixer-1a2b3c4d",
  "branch": "seekforge/agent-fixer-1a2b3c4d" } }
```

`agent_send` on that dispatch continues in the same worktree, and its review
covers everything the agent changed. Otherwise review or merge the branch
with git. The agent's transcript is copied to the parent's
`.seekforge/sessions/`, so it outlives the worktree.

## Background agents across runs

By default a dispatch belongs to the run that started it: when the run ends,
anything still running is cancelled. A host that keeps one conversation open
(a REPL, a TUI tab, a server session) can instead create one manager for the
whole session, pass it to every run as `dispatchManager`, and dispose it when
the session ends:

```ts
import { createDispatchManager } from "@seekforge/core";

const dispatchManager = createDispatchManager({ sessionScoped: true });
// every run of this session: createAgentCore({ ...deps, dispatchManager })
// session end: dispatchManager.disposeAll();
```

With a session-scoped manager, a run that ends cancels only its foreground
dispatches. Its background dispatches keep running, and:

- their outcome is appended to the next run's task in a
  `<background-agent-results>` block (so a resumed session keeps it), or, if
  they finish during a later run, delivered at its next turn;
- their terminal `subagent.*` event is emitted in that later run;
- the tokens they spend after their run ended are billed to the next run;
- they can no longer ask for permission: every prompt is answered "no", and
  an isolated agent's change is kept on its branch for review.

A result already read with `agent_result` is not delivered again.

`seekforge serve` (and Desktop through it) keeps one such manager per session:
background agents keep running after a turn ends, their cards can still be
steered or cancelled, and deleting the session or stopping the server cancels
them (see the [server API](../apps/server/SERVER-API.md)).

## Progress reports

A dispatched agent may call `agent_report` with one short line — a milestone,
a finding the parent can act on, or a blocker. Lines are cut at 500
characters and limited to 20 per run. The parent reads them at its next turn,
framed as data from the agent rather than instructions, and `agent_result`
lists the recent ones while the agent is still running. A definition can
remove the tool with `disallowedTools: [agent_report]`.

## Events

Dispatches emit `subagent.started`, `subagent.step` and one terminal
`subagent.completed` / `subagent.failed` / `subagent.cancelled` event (see the
[server API](../apps/server/SERVER-API.md)). Each carries the definition's
`color` when it has one. A progress line arrives as a `subagent.step` whose
`toolName` is `agent_report` and whose `message` is the line; it is model
output and should be rendered as data. The TUI keeps one session-scoped
manager per tab (a new, resumed or forked session, a detached run and a closed
tab each end it), draws each subagent row in its definition's color, and shows
the latest progress lines under it as plain text.

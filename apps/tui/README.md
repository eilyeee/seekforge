# @seekforge/tui

A polished terminal UI for [SeekForge](../../README.md), built with
[Ink](https://github.com/vadimdemedes/ink) (React for the terminal). It drives
the in-process `@seekforge/core` AgentCore — no server required.

## Run

```bash
pnpm --filter @seekforge/tui build
node apps/tui/bin/seekforge-tui.js     # or: seekforge-tui (when linked)
```

First run without an API key opens a setup wizard.

### Launch flags

| Flag | Effect |
| --- | --- |
| `-c`, `--continue` | resume the most recent session of this project |
| `--resume <id>` | resume a specific session (refused when it does not exist; not with `-c`) |
| `-m`, `--model <name>` | model for the session |
| `--permission-mode <mode>` | tabs start in `default` / `acceptEdits` / `plan` / `bypassPermissions` (also `confirm` / `auto`); Shift+Tab still cycles |
| `-y`, `--yes`, `--dangerously-skip-permissions` | start in auto approval (`--permission-mode` wins when both are given) |
| `--add-dir <dir>` | extra read-only root for `@` references; repeatable, same rules as `/add-dir` |
| `--settings <file>` | a JSON settings file, user-owned, layered above the config files |
| `--profile <name>` | a named `profiles` overlay (also `SEEKFORGE_PROFILE`) |
| `--mcp-config <file>` | MCP servers from `{ "mcpServers": { … } }` (or a bare map), merged over config |
| `--strict-mcp-config` | use only the `--mcp-config` servers |
| `--append-system-prompt <text>` | appended to every run's system prompt |
| `--vim` / `--no-vim` | start the composer in (or out of) vim mode |
| `--verbose` | start with verbose transcript output (Ctrl+O toggles) |
| `-h`, `--help` | print the flag list |

Values go either after the flag or after `=` (`--profile=ci`); use the `=` form
for a value that starts with `-`. Anything else — an unknown flag, a stray
argument — stops the launch with an error instead of being ignored.

`seekforge-tui` launches a full-screen chat in the current working directory.
A DeepSeek API key is required: set `DEEPSEEK_API_KEY` or write
`~/.seekforge/config.json` with `{ "apiKey": "…" }`. Config precedence is
`env > --settings file > --profile overlay > project .seekforge/config.json >
~/.seekforge/config.json` (the CLI's stack without `config.local.json`), with the
same repository-trust reductions.

## Interface

- **Transcript**: user prompts, streamed assistant markdown with
  syntax-highlighted code blocks, tool rows, an in-place plan checklist
  (☐ ◐ ☑), inline colored diffs for every `apply_patch`/`write_file`, nested
  structured dispatched-subagent cards with running/done/failed/cancelled
  states and recent tool steps, and a final report block.
  PageUp/PageDown scroll the managed viewport; Esc jumps back to latest.
- **Composer**: multiline (trailing `\` or Ctrl+J inserts a newline), ↑/↓
  history persisted across sessions, Ctrl+U clears, Ctrl+G (or `/editor`)
  edits the draft in `$VISUAL`, then `$EDITOR`, falling back to `vi`. Editor
  values may include quoted paths and arguments (for example
  `EDITOR='code --wait'`); they are parsed into argv without invoking a shell.
  The same editor resolution is used by `/memory edit` and `/config edit`.
  Typing `/` opens the command palette; typing
  `@` opens a fuzzy, frecency-ranked file picker (the picked file's contents
  are inlined on send); `# <fact>` saves to project memory; `!cmd` runs a
  local shell command directly (no agent, output inline).
- **Steering**: the composer stays live while the agent works — Enter queues
  follow-up messages that are sent in order after the turn; Esc interrupts
  the run (and clears the queue).
- **Recall & completion**: Ctrl+R reverse-searches the persisted history
  incrementally (Ctrl+R again steps older, Enter accepts); Tab completes
  plain path tokens against the workspace file index (repeated Tab cycles).
- **Backtrack**: Esc Esc on an empty idle composer (or `/backtrack`) opens a
  picker of this session's earlier messages — Enter rewinds the conversation
  AND restores files to that turn (per-turn checkpoints); `c` rewinds the
  conversation only; `/rewind` still covers whole-session file rollback.
- **Vim mode**: `/vim` toggles modal editing (h j k l w b e 0 $ gg G, i a I A
  o O, x dd dw cw cc D C s S, yy p, u undo); the status bar shows
  INSERT/NORMAL. `"vim": true` in config starts with it on.
- **Run control**: Ctrl+B detaches the current run to the background (chat
  continues in a fresh session; its outcome arrives as a notice); Ctrl+O
  toggles verbose mode (full diffs, shell output, tool results); Ctrl+Z
  suspends to the shell; the mouse wheel scrolls the transcript.
- **Agent questions**: the `ask_user` tool pops a multiple-choice panel
  (↑↓ or 1-N, Enter answers, Esc declines).
- **Attachments**: Ctrl+V captures a clipboard image into
  `.seekforge/uploads/` and inserts an `[image #N: path]` marker (carried in
  the task for vision-capable models); pastes over 6 lines collapse into a
  `[Pasted text #N]` placeholder expanded on send.
- **Custom commands**: `.seekforge/commands/<name>.md` (project or
  `~/.seekforge/commands/`) become `/name` palette entries — see
  [Custom commands](#custom-commands).
- **Keybindings**: every action can be rebound — see [Keybindings](#keybindings).
  Alt+P opens the model picker, Alt+T toggles thinking.
- **Modes**: persistent approval mode auto / confirm / plan — Shift+Tab
  cycles, `/approve <mode>` sets it. In plan mode every message runs a
  read-only planning turn, then `y` executes it in the same session.
- **Permissions**: an inline panel shows the RAW command/path verbatim;
  `y` allows once, `a` allows similar commands for the rest of the session,
  `A` also saves the rule core proposed to `~/.seekforge/config.json`,
  `N` or Tab opens a one-line reason (Enter denies and the model reads the
  reason), anything else denies. `a` and `A` are only offered when core will
  honor them (never for `env`-level tools). Long diffs and plans (a request
  whose preview is text, such as a plan to approve) scroll with ↑↓ PgUp PgDn;
  a full-file diff opens at its first change. With an IDE connected, `o` opens
  the proposed change in the IDE's diff view.
- **Status line**: model · context % · cost · tokens · the connected IDE ·
  approval mode · `⚙ N bg` background tasks · scroll indicator, with a spinner
  while running.

## Slash commands

`/help` (commands and the effective key bindings) `/new` `/clear [name]`
`/sessions` `/resume <id>` `/rename <title>` `/fork`
`/plan <task>` `/approve [auto|confirm|plan]` `/rewind [yes]` `/backtrack`
`/diff` `/review` `/model` (picker) `/think [on|off|high|max]`
`/remember <fact>` `/memory [edit]` `/config [edit]` `/status` `/usage`
`/todo [add|done|rm]` `/add-dir [path]` `/ide [off]`
`/tasks [kill <id>]` `/agents` `/agent-steer <dispatch-id> <message>`
`/agent-cancel <dispatch-id>` `/skills` `/plugins` `/mcp` `/permissions`
`/hooks` `/init` `/release-notes` `/bug`
`/loop` `/loop-resume` `/loop-pause` `/loop-continue` `/loop-steer <guidance>`
`/graph-list` `/graph-show <graph-id>` `/graph-pause <graph-id>`
`/graph-continue <graph-id>` `/graph-steer <graph-id> <guidance>`
`/graph-signal <graph-id> <name>`
`/doctor` `/vim` `/terminal-setup` `/context` `/compact` `/usage`
`/export [path]` `/copy` `/editor` `/quit` — plus custom commands from
`.seekforge/commands/`.

The `/graph-*` commands drive an Engineering Graph persisted under
`.seekforge/graphs/`, including one started by `seekforge graph run` in another
process: `/graph-pause`, `/graph-continue` and `/graph-steer` queue a durable
control command that the executing run applies at its next safe boundary, and
`/graph-signal` delivers a wait signal to a node that declares one. The TUI has
no `/graph-run` — starting, restarting, or approving a Graph node still goes
through the CLI (`seekforge graph run|resume <file> --approve <node-id>`),
because those need the Graph definition file, not just its checkpoint.

**Sessions.** `/sessions` lists every session with its name (★), status, age,
cost and id, and previews the selected one (first prompt, last reply). `/`
starts a search over id, name and task; `r` renames the selected session
inline (an empty name clears it); `f` forks it; Enter resumes it. `/rename
<title>` names the current session, and `/clear <name>` names the one it
leaves. Names are stored beside the session (`core renameSession`), so they
survive a running loop rewriting `session.json`.

**Management panels.** These open an interactive panel instead of printing:

- `/permissions` — every rule with the layer it comes from (`--settings`,
  profile, project, user) and this session's command grants. `a` adds a rule
  (tool, action `deny`/`ask`/`allow`, match prefix, scope `user`/`project`),
  `d` then `y` deletes one. The project file may only hold `deny` and `ask`
  rules — the loader strips project `allow` rules, so the panel refuses to
  write one there and marks existing ones as ignored. User-file edits take the
  same cross-process lease as the prompt's `A`; project-file edits wait for no
  run to own the workspace. Changes apply from the next run.
- `/mcp` — each server's state (connected, failed with the reason, untrusted,
  pending) with tool, prompt and resource counts. `r` reconnects one server,
  `e` switches a server defined in your user config off or on (its `trusted`
  flag, written to `~/.seekforge/config.json`; switching on asks first, since it
  lets the server start), and `l` copies `seekforge mcp login <name>` for a
  remote server. Repository and plugin servers are not switched here.
- `/agents` — agents with their scope; `n` walks a short form (id, description,
  tools, mode, model, project or global) and writes
  `.seekforge/agents/<id>/AGENT.md`; `e` or Enter opens an agent's file in
  `$EDITOR`.
- `/hooks` — the configured hooks stage by stage with matcher, type and raw
  command (config first, then plugins); `e` opens `~/.seekforge/config.json`.
- `/skills` and `/plugins` — Space or Enter switches the selected entry
  (core's `setSkillEnabled` / `setPluginEnabled`, the same owners as the CLI).
  Enabling a plugin approves its current contents and asks first, naming what
  it contributes; repository plugins are installed with
  `seekforge plugin install` first. Plugin changes apply after a restart.

**IDE bridge.** `/ide` lists running editor bridges from
`~/.seekforge/ide/<port>.json` lock files — the ones whose workspace folder
contains this project first — and Enter connects; `/ide off` disconnects. A
lock file is only believed when it is a regular file owned by you with mode
`0600` in a directory only you can write, and its process is alive. While
connected, every prompt you type carries a bounded `<ide-context>` block (the
active file, the selection up to 4,000 characters, up to 20 error
diagnostics), limited to files inside the workspace and never a sensitive file,
wrapped as untrusted data; a notice says what was attached. The permission
panel's `o` opens a pending edit in the IDE's diff view.

Background tasks started with `run_command background:true` survive across
turns (one shared manager per TUI process; killed on exit). When one exits, the
session that started it is told at its next turn boundary — a notice in the
transcript and a short note to the agent pointing at `task_output`. `/compact` folds
the middle of the stored session into a digest immediately. `/init` runs an
agent task that writes or refreshes AGENTS.md; `/doctor` checks the
environment (key, node, git, runtime, MCP, editor, clipboard). Permission
prompts and run completion trigger an OS notification (macOS/Linux) plus a
terminal bell — `"notify": false` / `"bell": false` disable each.

## Custom commands

Each `*.md` file under `.seekforge/commands/` (project) or
`~/.seekforge/commands/` (user) becomes a `/name` palette entry, where `name`
is the filename without `.md`. Subdirectories namespace with `:` —
`commands/frontend/build.md` is `/frontend:build`. On a name clash the project
copy wins over the user copy. A built-in command keeps its name in the TUI: a
checked-out repository cannot replace `/approve` or `/permissions` with a file,
so a custom command named like a built-in is not reachable here (the CLI REPL
lets the custom command win).

The body is the prompt. An optional YAML frontmatter block configures it:

```markdown
---
description: Open a PR for the current branch
argument-hint: <base branch>
model: deepseek-v4-pro
allowed-tools: read_file, run_command
---
Open a pull request from !`git branch --show-current` into $1.

Arguments: $ARGUMENTS
```

- `description` — palette label (defaults to the first non-empty body line).
- `argument-hint` — shown next to the name in the palette and `/help`.
- `model` — this invocation runs on that model.
- `allowed-tools` — this invocation may call only these tools.
- `disable-model-invocation: true` — the model cannot run it through
  `run_user_command`.

The frontmatter is stripped from the sent body. The TUI reads command files
through Core (`packages/core/src/agent/commands.ts`), the same implementation
as the CLI REPL and the server, so a file behaves the same on every surface.

**Arguments.** `$ARGUMENTS` (every occurrence) is replaced with the full
argument string; positional `$1`..`$9` take the whitespace-split arguments. If
the body has no placeholder, non-empty arguments are appended as an
`Arguments: …` line.

**Shell injection.** `` !`command` `` in the body runs in the workspace at
invoke time and its trimmed output is inlined; a failing command becomes an
inline `[command failed: …]` marker. This runs only when *you* invoke the
command, with a 10-second timeout and a 1 MB output cap, and not while another
run owns the workspace (the same guard the server applies).

**Model invocation.** The model can invoke any command not marked
`disable-model-invocation: true` via the `run_user_command` tool. That path
only does `$ARGUMENTS`/`$1`..`$9` interpolation — it never runs `` !`shell` ``
injections.

## Keybindings

`~/.seekforge/keybindings.json` and `<workspace>/.seekforge/keybindings.json`
(project wins per action) map a scope to action → key spec:

```json
{
  "composer": { "newline": "ctrl+j", "external-editor": "ctrl+x ctrl+e" },
  "global": { "model-picker": "alt+m", "toggle-sidebar": "ctrl+x s" }
}
```

A spec is modifiers (`ctrl`, `shift`, `alt`/`meta`/`option`) plus one key — a
character or `return`, `escape`, `tab`, `up`, `down`, `left`, `right`, `pageup`,
`pagedown`, `backspace`, `delete`. Two or three space-separated strokes make a
chord (composer and global scopes only); a chord's first stroke waits 1.5 s for
the rest, and the footer shows it. An override replaces the built-in keys for
that action.

| Scope | Actions |
| --- | --- |
| `composer` | `submit` `newline` `history-up` `history-down` `cursor-left` `cursor-right` `clear-line` `delete-back` `delete-forward` `external-editor` `history-search` `path-complete` `paste-image` |
| `overlay` | `overlay-up` `overlay-down` `overlay-accept` `overlay-close` |
| `global` | `cancel-or-quit` `cycle-approval` `scroll-up` `scroll-down` `scroll-latest` `toggle-verbose` `detach-run` `suspend` `tab-new` `tab-cycle` `toggle-sidebar` `toggle-pager` `model-picker` `toggle-thinking` |

Composer actions may also be bound in `global`. An unknown scope or action, an
action bound in a scope that never runs it, an unparsable spec, or a chord that
hides a single-key binding is reported when the TUI starts, not silently
dropped. Ctrl+C always cancels (and twice quits), whatever else
`cancel-or-quit` is bound to. `/help` lists the bindings in effect.

Alt shortcuts work when the terminal sends Alt as an ESC prefix (the common
default; on macOS enable "Use Option as Meta key"), including terminals and
multiplexers that deliver the ESC and the key separately.

## Development

```bash
pnpm --filter @seekforge/tui dev        # tsx, needs a TTY
pnpm --filter @seekforge/tui test       # vitest unit tests (pure logic only)
pnpm --filter @seekforge/tui typecheck  # tsc --noEmit
```

Architecture: `model.ts` is the single reducer/state hub (overlays, scroll,
approval, bg tasks all live there); `keymap.ts` is a declarative key table;
components are presentation-only; `app.tsx` owns input and command routing,
while `use-terminal-lifecycle.ts` and `use-statusline.ts` isolate process-level
terminal effects and scheduled status-line execution.
Theme: set `accent` in config or `SEEKFORGE_TUI_ACCENT` (any Ink color name);
`NO_COLOR` is respected.

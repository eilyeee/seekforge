# @seekforge/tui

A polished terminal UI for [SeekForge](../../README.md), built with
[Ink](https://github.com/vadimdemedes/ink) (React for the terminal). It drives
the in-process `@seekforge/core` AgentCore — no server required.

## Run

```bash
pnpm --filter @seekforge/tui build
node apps/tui/bin/seekforge-tui.js     # or: seekforge-tui (when linked)
```

Flags: `-c/--continue` resumes the most recent session; `--model <name>`,
`--vim/--no-vim`, `-h`. First run without an API key opens a setup wizard.

`seekforge-tui` launches a full-screen chat in the current working directory.
A DeepSeek API key is required: set `DEEPSEEK_API_KEY` or write
`~/.seekforge/config.json` with `{ "apiKey": "…" }`. Config precedence is
`env > project .seekforge/config.json > ~/.seekforge/config.json` (same as the
CLI).

## Interface

- **Transcript**: user prompts, streamed assistant markdown with
  syntax-highlighted code blocks, tool rows, an in-place plan checklist
  (☐ ◐ ☑), inline colored diffs for every `apply_patch`/`write_file`, nested
  `↳ [agent] tool` rows for dispatched subagents, and a final report block.
  PageUp/PageDown scroll the managed viewport; Esc jumps back to latest.
- **Composer**: multiline (trailing `\` or Ctrl+J inserts a newline), ↑/↓
  history persisted across sessions, Ctrl+U clears, Ctrl+G (or `/editor`)
  edits the draft in `$EDITOR`. Typing `/` opens the command palette; typing
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
  `~/.seekforge/commands/`) become `/name` palette entries; `$ARGUMENTS` in
  the body is replaced with what you type after the command.
- **Keybindings**: override any binding in `.seekforge/keybindings.json`
  (`{"composer": {"newline": "ctrl+j"}}` style; project overrides global).
- **Modes**: persistent approval mode auto / confirm / plan — Shift+Tab
  cycles, `/approve <mode>` sets it. In plan mode every message runs a
  read-only planning turn, then `y` executes it in the same session.
- **Permissions**: an inline panel shows the RAW command/path verbatim;
  `y` allows once, `a` allows similar commands for the rest of the session,
  anything else denies.
- **Status line**: model · context % · cost · tokens · approval mode ·
  `⚙ N bg` background tasks · scroll indicator, with a spinner while running.

## Slash commands

`/help` `/new` `/clear` `/sessions` (picker; `f` forks) `/resume <id>` `/fork`
`/plan <task>` `/approve [auto|confirm|plan]` `/rewind [yes]` `/backtrack`
`/diff` `/review` `/model` (picker) `/think [on|off|high|max]`
`/remember <fact>` `/memory [edit]` `/todo [add|done|rm]` `/add-dir [path]`
`/tasks [kill <id>]` `/agents` `/skills` `/mcp` (incl. resources) `/init`
`/doctor` `/vim` `/terminal-setup` `/context` `/compact` `/usage`
`/export [path]` `/copy` `/editor` `/quit` — plus custom commands from
`.seekforge/commands/`.

Background tasks started with `run_command background:true` survive across
turns (one shared manager per TUI process; killed on exit). `/compact` folds
the middle of the stored session into a digest immediately. `/init` runs an
agent task that writes or refreshes AGENTS.md; `/doctor` checks the
environment (key, node, git, runtime, MCP, editor, clipboard). Permission
prompts and run completion trigger an OS notification (macOS/Linux) plus a
terminal bell — `"notify": false` / `"bell": false` disable each.

## Development

```bash
pnpm --filter @seekforge/tui dev        # tsx, needs a TTY
pnpm --filter @seekforge/tui test       # vitest unit tests (pure logic only)
pnpm --filter @seekforge/tui typecheck  # tsc --noEmit
```

Architecture: `model.ts` is the single reducer/state hub (overlays, scroll,
approval, bg tasks all live there); `keymap.ts` is a declarative key table;
components are presentation-only — all input routing happens in `app.tsx`.
Theme: set `accent` in config or `SEEKFORGE_TUI_ACCENT` (any Ink color name);
`NO_COLOR` is respected.

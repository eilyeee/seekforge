# @seekforge/tui

A polished terminal UI for [SeekForge](../../README.md), built with
[Ink](https://github.com/vadimdemedes/ink) (React for the terminal). It drives
the in-process `@seekforge/core` AgentCore — no server required.

## Run

```bash
pnpm --filter @seekforge/tui build
node apps/tui/bin/seekforge-tui.js     # or: seekforge-tui (when linked)
```

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
  are inlined on send); `# <fact>` saves to project memory.
- **Modes**: persistent approval mode auto / confirm / plan — Shift+Tab
  cycles, `/approve <mode>` sets it. In plan mode every message runs a
  read-only planning turn, then `y` executes it in the same session.
- **Permissions**: an inline panel shows the RAW command/path verbatim;
  `y` allows once, `a` allows similar commands for the rest of the session,
  anything else denies.
- **Status line**: model · context % · cost · tokens · approval mode ·
  `⚙ N bg` background tasks · scroll indicator, with a spinner while running.

## Slash commands

`/help` `/new` `/sessions` `/resume <id>` `/plan <task>`
`/approve [auto|confirm|plan]` `/rewind [yes]` `/model <name>`
`/remember <fact>` `/tasks` `/agents` `/mcp` `/context` `/compact` `/usage`
`/copy` `/editor` `/quit`

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

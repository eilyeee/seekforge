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

- Scrolling transcript: user prompts, streamed assistant markdown, tool rows
  with a status glyph + dimmed args, an in-place plan checklist (☐ ◐ ☑),
  file-changed badges, and a final report block.
- Status line: model · context-window occupancy % · cumulative cost · tokens,
  with a spinner + "working…" while a turn runs.
- Inline permission panel showing the RAW command/path verbatim; press `y` to
  approve, any other key to deny.
- Composer with slash commands: `/help` `/new` `/model <name>` `/context`
  `/usage` `/quit`. `@path` tokens inline file contents.
- Ctrl+C cancels a running task; a second Ctrl+C (or Ctrl+C while idle) exits.

## Development

```bash
pnpm --filter @seekforge/tui dev        # tsx, needs a TTY
pnpm --filter @seekforge/tui test       # vitest unit tests (pure logic only)
pnpm --filter @seekforge/tui typecheck  # tsc --noEmit
```

## Deferred to a later iteration

- MCP is assembled (`prepareMcp`) but untested end-to-end here.
- A dedicated diff pane for `file.changed` (currently a one-line badge).
- Scrollback/viewport management for very long transcripts.

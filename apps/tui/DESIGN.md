# SeekForge TUI — Design & Feature Plan

`seekforge-tui` is the full-screen terminal interface, sitting between the
line-based REPL (`seekforge`) and the web workbench (`seekforge serve`).
Stack: Ink 5 (React for the terminal) + the in-process `@seekforge/core`
AgentCore (no server). Aesthetic target: Claude Code's TUI — calm, modern,
single accent color, generous spacing, rounded boxes.

> Status: **v2 shipped (0.7.0)** — all four batches (A input & navigation,
> B review & modes, C sessions/memory/surfaces, D polish) are implemented;
> this document is the design record. Built contract-first: model.ts /
> commands.ts / keymap.ts landed first, then the batches in parallel
> worktrees, then app.tsx integration.

## Reference points

- **Parity target — Claude Code TUI**: slash command palette, `@` file
  picker, scrollback, plan/permission modes, inline diffs, in-TUI session
  resume, rich status line, multiline composer with history, keybindings.
- **Widget reference — DeepSeek-TUI** (`~/code/github/DeepSeek-TUI`, Rust/
  ratatui, MIT): its widget set is the most complete catalog of a terminal
  coding-agent UI — `command_palette`, `composer_ui`, `diff_render`,
  `file_picker` / `file_mention` / `file_frecency`, `context_inspector`,
  `approval`, `backtrack`, `external_editor`, `feedback_picker`, `file_tree`.
  We borrow the *interaction design* (not the Rust code; we reimplement in Ink).

## v1 inventory (already shipped)

Components: Header, Transcript, ToolRow, PlanCard, ReportCard, PermissionPanel,
StatusBar, Composer, Markdown. Reducer `model.ts` maps `AgentEvent`s to
renderable items (streaming-delta coalescing, tool start/complete pairing,
plan upsert, context.usage, report). Slash: `/help /new /context /usage /quit`.
Agent runs in-process via `agent/run-session.ts`; `@path` inlines files;
Ctrl+C cancels then exits.

## Gap analysis vs Claude Code (what v1 is missing)

| Area | Claude Code | TUI v1 | Gap |
| --- | --- | --- | --- |
| Slash commands | full set + autocomplete palette | 6 commands, no palette | large |
| File reference | `@` opens a fuzzy file picker | `@path` only as literal text | large |
| Scrollback | viewport, page up/down, jump to top | append-only, terminal scroll | medium |
| Diff view | inline colored diffs for edits | one-line "changed" badge | medium |
| Plan mode | toggle; plan → approve → execute | not in TUI (CLI only) | medium |
| Approval modes | auto / per-tool / plan; persistent | per-call y/n only | medium |
| Session mgmt | list / resume / fork in-session | `/new` only | medium |
| Composer | multiline, history (↑/↓), paste, edit | single line input | medium |
| Memory | `#` to remember inline | none | small |
| Context tools | inspect / compact on demand | `%` in status bar only | small |
| Keybindings | Esc cancel, Ctrl+R history, etc. | Ctrl+C only | small |
| Background tasks | indicator + output peek | none surfaced | small |
| MCP / agents | reachable | assembled, not surfaced | small |
| Syntax highlight | code blocks highlighted | plain code blocks | small |
| Theme | adapts to terminal | fixed palette | small |

## Implementation batches

Each batch is a self-contained, testable increment. Pure logic (reducers,
fuzzy matching, diff parsing, keymap) is unit-tested with vitest; Ink render
is verified by build + manual TTY run.

### Batch A — input & navigation (the daily-driver core)
- **Slash command palette**: typing `/` opens an overlay listing commands with
  descriptions; arrow/Tab to select, fuzzy filter, Enter runs. Extensible
  registry so later batches just register commands.
- **`@` file picker**: typing `@` opens a fuzzy file finder over the workspace
  (respect ignore list; frecency-ranked à la DeepSeek-TUI `file_frecency`);
  selection inserts the path and still inlines the file on send.
- **Multiline composer**: Shift+Enter newline, history with ↑/↓ (persisted to
  `.seekforge/tui-history`), Ctrl+U clear, Esc to cancel a running task
  without quitting (distinct from Ctrl+C quit).
- **Scrollback**: a managed viewport with PageUp/PageDown and "jump to latest";
  cap rendered items, virtualize older ones.

### Batch B — review & modes
- **Inline diff rendering**: when `apply_patch`/`write_file` succeeds, fetch the
  before/after (we already checkpoint) or run `git diff` for the file and show
  a collapsible colored hunk view (port the web `DiffBlock` design to Ink).
- **Plan mode**: `/plan <task>` and a header indicator; read-only investigate →
  show plan → `y` executes in the same session (mirror the CLI `--plan` flow).
- **Approval modes**: a persistent mode (auto / confirm / plan) toggled with a
  key or `/approve`; the permission panel gains "allow once / allow for session
  / deny"; "allow for session" feeds `commandAllowlist` for that run.
- **Backtrack / edit-resend**: ↑ in an empty composer edits the last user
  message; optionally rewind file changes since then (we have `rewindSession`).

### Batch C — session, memory, surfaces
- **In-TUI sessions**: `/sessions` lists with status/cost; `/resume <id>`
  continues; show the active session id in the header.
- **Memory**: `#<fact>` (or `/remember`) writes a fact directly (audit
  candidate), confirmation toast.
- **Background tasks**: a status-bar indicator (`⚙ 2 bg`) and `/tasks` to peek
  `task_output` / kill.
- **Context inspector**: `/context` opens an overlay (not just the % in the
  bar): message count, token breakdown, what's pinned, a manual `/compact`.
- **MCP / agents surfacing**: `/agents` and `/mcp` list what's available;
  dispatched-subagent activity rendered as nested rows (mirror the web substep).

### Batch D — polish (borrow DeepSeek-TUI's refinements)
- Syntax-highlighted code blocks (lightweight tokenizer, no heavy dep).
- Theme detection / a couple of presets; respect `NO_COLOR`.
- Command palette niceties: recent commands, inline argument hints.
- External editor (`$EDITOR`) for long prompts (DeepSeek-TUI `external_editor`).
- Feedback / copy-last-block helpers (`feedback_picker`, `clipboard`).

## Architecture notes (keep v2 maintainable)

- Keep `model.ts` the single source of renderable state; every new surface is a
  reducer field + a component, never ad-hoc state in components.
- Overlays (palette, file picker, context inspector) are a small overlay stack
  in the reducer (`overlay: null | {...}`), so input routing is centralized:
  keystrokes go to the top overlay first, else the composer.
- A `keymap.ts` table (key → action) so bindings are declarative and testable.
- Reuse `@seekforge/core` and the web UI's *design language* (colors, the diff
  colorizer, the tiny markdown) — do not fork logic that already exists.
- No app→app imports: the TUI keeps its own thin config/agent assembly (as v1
  already does), mirroring `apps/cli`.

## Entry & precedence

`seekforge-tui` launches the TUI. A future option: `seekforge` (no args) on a
TTY could default to the TUI, keeping the plain REPL available as `seekforge
chat`. Decide once the TUI is feature-complete enough to be the default.

Form-factor precedence, unchanged:
CLI (scripts/CI, `--json`) → REPL (minimal line mode) → **TUI (terminal daily
driver)** → App (visual workbench).

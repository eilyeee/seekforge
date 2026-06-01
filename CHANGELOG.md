# Changelog

## Unreleased

### round 33: headless/SDK-parity CLI flags
Closes the remaining Claude-CLI flag gaps (all SDK/automation-oriented):
- `--dangerously-skip-permissions` — alias for `-y` (auto-approve everything).
- `--mcp-config <file>` — load MCP servers from a JSON file for the run
  (`{mcpServers:{…}}` or a bare `{name:server}` map), merged over the config
  file's servers; `--strict-mcp-config` uses ONLY the file's (ignores config).
- `--replay-user-messages` — with `--input-format stream-json`, echo each user
  turn back as a `{type:"user"}` stream event.
- `--include-partial-messages` — with `--output-format stream-json`, emit
  assistant text deltas as `content_block_delta` stream events.
- `--permission-prompt-tool` is intentionally NOT added: it requires routing the
  permission-confirm path through an MCP tool execution (architecturally
  invasive) for the lowest-value, SDK-only case, and can't be verified against
  Claude's exact protocol here.

### round 32: configurable model list (pickers read it, not just DeepSeek)
- New `models` config key (string[]) — your own list of selectable model ids.
  Server `setConfigValue` + CLI `config set` accept it (comma-separated, like
  commandAllowlist); GET /api/config returns it, defaulting to core's
  non-deprecated ids when unset so a picker is never empty.
- The desktop **chat-box model control is now a strict dropdown** reading
  `config.models` (no longer a hardcoded deepseek-v4 list); the active value
  stays selectable even if it's not in the list.
- Settings gains a **models list editor** (comma-separated) and the default
  `model` is now picked from that list. Add any id — including other
  OpenAI-compatible providers (set baseUrl + apiKey for those).

### round 31: native top-bar clicks + sandbox/engine settings in the UI
Two issues found running the native desktop app:
- **macOS overlay title bar ate clicks on the top toolbar** (tab bar, mode
  toggles, New session, "+" menu) — they sit at y=0, under the draggable
  title-bar zone, so clicks dragged the window instead. The content column now
  reserves a draggable strip at the top (matching the sidebar's `pt-9`), pushing
  the top chrome below the title bar so it's clickable. (Composer/sidebar were
  unaffected and always worked.)
- **The OS sandbox (and other engine knobs) couldn't be set from the UI** — only
  apiKey/model/baseUrl/runtimeBin/commandAllowlist were settable. Added
  `sandbox`, `compaction`, `thinking`, `reasoningEffort` to the writable config
  keys (server `setConfigValue` + CLI `config set`, with enum/boolean
  validation) and to the desktop Settings (dropdowns + a thinking checkbox). The
  sandbox badge in the toolbar remains a status display; you set it here.

### round 30: CLI i18n (English + 简体中文)
Completes the i18n work (TUI + desktop already done): the CLI's user-facing
chrome is now translatable.
- `apps/cli/src/i18n.ts`: TUI-style flat key→string tables with an English
  fallback; locale resolved once at startup (`config.locale` > `SEEKFORGE_LANG`
  > `LC_ALL`/`LANG` > en). Tables split into i18n/{common,repl,commands}.
- Translated: `fail()` messages + hints, the text-mode renderer labels, the REPL
  chrome (/help, prompts, status), and command output (status, sessions, models,
  doctor, memory, …). A `locale` config key is added.
- Deliberately NOT translated: `--help`/option text (kept English), and all
  machine output (`--output-format json`/`stream-json`, output-format.ts) stays
  byte-stable English so scripts keep parsing it.

### round 29: desktop i18n (English + 简体中文)
The desktop app had no i18n (all hardcoded English) while the TUI did. Added a
matching lightweight layer — no deps, a flat key→string table per locale with an
English fallback chain — now covering the whole desktop UI in **en + zh-CN**:
- `lib/i18n.ts` engine: `t()` / `useT()` (live re-render via `useSyncExternalStore`),
  `detectLocale` (stored choice > browser language > en), localStorage-persisted.
  String tables split by feature (i18n/common, i18n/views, i18n/chat).
- Every desktop component/view translated (sidebar, chat toolbar/stream/composer,
  permission + question modals, all 8 views, onboarding, todos, theme switcher).
- A language picker in Settings (en / 中文（简体）), live-switching like the theme.
- Built in parallel (3 dogfood sessions on disjoint file-groups) then reviewed:
  fixed a `t`/Todo variable shadow and pinned the locale in the renderer-free
  PermissionModal test (Node's navigator.language follows the OS, so the default
  was non-deterministic). Verified by screenshotting the running app in zh-CN.
- CLI i18n is the next wave.

### round 28: ship the web UI in the npm package + dev server resolution
Found by actually running the native desktop app (`pnpm tauri dev`): it printed
"web UI is not built" because the Tauri shell spawned the globally-installed
`seekforge`, which ships no UI.
- **`seekforge serve` now ships a web UI.** The published `seekforge` package
  excluded the desktop build, so `seekforge serve` (documented as "local web UI
  + agent API") only ever served the API. The cli build now copies the desktop
  `dist` into `dist/web`, `resolveStaticRoot` falls back to it, and
  `prepublishOnly` builds the desktop first — so npm installs get a real
  workbench.
- **Dev builds prefer the repo's server.** `resolve_serve_command` gains a
  `prefer_repo` flag (passed `cfg!(debug_assertions)`): a `tauri dev` from a
  source checkout now uses the repo's server (which serves the freshly-built UI)
  instead of an older `seekforge` on PATH. Release builds are unchanged.

### round 27: desktop UI design polish
A UI-design pass on the desktop app (the token system, themes, modals, and
button philosophy were already solid — these are refinements):
- **Unified iconography.** ~27 inline unicode glyphs used as icons in the chat
  stream (✻ thinking, ▸/▾ expand carets, ⤷ subagent, → arrows) are replaced with
  SVG icons (`IconSparkle`/`IconChevron`/`IconCornerDownRight`/`IconArrowRight`),
  so weight/baseline/color are consistent across platforms and CJK fonts.
  Genuinely-textual characters (streaming cursor ▌, `·` separators) are kept.
- **Tighter accent hierarchy.** The whale-blue accent was tinting too many
  secondary things; it's now reserved for the user's own messages and
  interactive elements. The "session completed" card uses the success color
  (`ok`); subagent/agent rows are neutral.
- **One micro type size.** Scattered `text-[9px]/[10px]/[11px]` (incl. an
  illegible 9px) collapse into a single `text-2xs` (11px) token in the Tailwind
  config.

### round 26: model-selection polish + REPL commands (Claude detail parity)
An audit vs Claude found stale deprecated-model defaults users would hit:
- **Desktop Settings could only pick `deepseek-chat`** — the dropdown omitted the
  actual default `deepseek-v4-flash` and `deepseek-v4-pro` entirely. Added a
  `GET /api/models` endpoint (server, sourced from core MODEL_PRICING/
  DEFAULT_MODEL/DEPRECATED_MODELS) that the SettingsView fetches: active models
  selectable (default marked), deprecated ones disabled and labelled.
- **`seekforge init`** scaffolded `model: "deepseek-chat"` (deprecated); now uses
  `DEFAULT_MODEL` from core (deepseek-v4-flash).
- **REPL** `/model` help no longer suggests the deprecated model, and the bare
  REPL gains `/clear`, `/diff`, `/status`, `/compact` (it was far thinner than
  the TUI). Single source of truth: all model lists come from core, not hardcode.

### round 22: per-hunk UI everywhere + a dogfood bug fix (parallel dogfood)
- **Per-hunk partial-apply now reaches the TUI and desktop** (completing the
  round-21 core+CLI contract). Two SeekForge dogfood sessions ran in parallel on
  disjoint dirs:
  - TUI `PermissionPanel`: multi-hunk requests render `[x]/[ ]` per-hunk
    checkboxes (number key toggles, `a` selects all, `y`/`n` confirm/deny),
    state in app.tsx; single-/no-hunk unchanged.
  - Desktop + ws: the `permission.response` frame carries optional
    `selectedHunks`; the server maps it to the core ConfirmResult and forwards
    `hunks` to the client; the desktop PermissionModal renders per-hunk
    selection. Backward compatible (boolean all-or-nothing when ≤1 hunk).
- **Bug fix: `seekforge models` flagged deprecated models.** It listed
  deepseek-chat/reasoner as plainly available; now a `DEPRECATED_MODELS` set in
  core (re-exported) drives a `(deprecated)` tag and sorts current models first.
- All built by SeekForge, then reviewed and independently verified: 7 packages
  typecheck; tui 662, desktop 217, server 119, cli 74, core 743 tests green.

### round 21: per-hunk partial-apply (hardest dogfood — cross-layer contract)
- **`apply_patch` per-hunk partial-apply (core + CLI).** When a patch has more
  than one edit, you can now approve/reject individual hunks instead of
  all-or-nothing. SeekForge implemented this itself via plan→execute on a
  genuinely hard, cross-layer change; reviewed and independently verified.
  - Additive contract: `ConfirmResult` gains a `{ allow: true; selectedHunks:
    number[] }` variant and `PermissionRequest` a `hunks?` field — existing
    `boolean` / `{allow,remember}` returns are byte-for-byte unchanged, so the
    TUI, desktop, and server WS frontends keep returning `boolean` and were not
    touched (they stay all-or-nothing until a future round adds the UI).
  - Core threads the selection from `confirmWithUser` → `ctx.selectedHunks` →
    `apply_patch.run` (filters edits to the chosen indices), and clears it after
    each call so it never leaks across tool invocations.
  - CLI `confirmInTerminal`: multi-hunk prompt offers apply-all / skip-all /
    pick indices (`0,2`); machine/non-interactive mode is unchanged.
  - 6 new core tests; all 7 packages typecheck and core/cli/tui/desktop/server
    suites pass.

### round 20: features built by dogfooding (SeekForge implementing SeekForge)
- **`seekforge models`** — lists each DeepSeek model with cache-miss/cache-hit
  input and output pricing (sourced from MODEL_PRICING), marking the default.
  Written by SeekForge in an edit dogfood, then reviewed.
- **`--settings <file>`** (Claude-Code style) — loads a JSON settings file and
  layers it into the resolved config, slotting between project config (below)
  and env vars / CLI flags (above); mcpServers/permissionRules/hooks keep their
  deep-merge semantics. Implemented by SeekForge via a full plan→execute
  dogfood. Review caught one integration bug the unit tests missed: the flag was
  read as `opts.settingsFile` but commander exposes single-word `--settings` as
  `opts.settings`, so the flag was silently ignored — fixed and verified live.

### round 19: dogfood fixes (bugs found by running SeekForge on SeekForge)
Four parallel dogfood sessions (3 read-only investigations + 1 live edit run)
surfaced real bugs only running the agent could expose:
- **`auto`/`-y` now actually auto-approves command execution.** The `execute`
  permission case had no `auto` branch, so `-y` / `--permission-mode
  bypassPermissions` still prompted for commands — and in headless mode that
  meant every non-allowlisted command was auto-DENIED. Matches the documented
  "auto-approve write/execute" contract now. (acceptEdits still confirms
  commands, by design.)
- **`search_text` no longer descends into `.seekforge/sessions/`** — it was
  ingesting escaped copies of the agent's own prior tool output (a
  self-pollution feedback loop that burned tokens).
- **Reasoning/thinking stream is clean in non-TTY output.** The CLI renderer
  forced color on for every interactive run, so piped/captured `ask` output was
  flooded with per-token ANSI escapes; it now honors the TTY-aware color gate.
- **Skills are no longer selected/announced in read-only ask mode** — they are
  task-execution procedures, irrelevant to Q&A (plan/edit still get them).
- **Stronger `--output-style` presets.** The original wording was too soft to
  visibly change responses; concise/explanatory/learning now state hard,
  shape-changing rules.
- **Citation guidance**: ask mode now instructs the model to take line numbers
  from actual tool output, never reconstruct them from memory (the dogfood found
  citations drifting 10–45 lines).
- Plus a feature SeekForge wrote itself during the edit dogfood: `seekforge
  completion bash|zsh` now offers `run` subcommand flags (function-based
  completion), not just top-level command names.

### round 18: CLI headless parity (Claude Code flag closeout)
- `--permission-mode <mode>`: Claude-compatible names (`default`/`acceptEdits`/
  `plan`/`bypassPermissions`) plus native (`confirm`/`auto`) map onto the core
  ApprovalMode; `plan` forces plan-first. Reaches `acceptEdits` from headless
  for the first time. Overrides `-y` when set.
- `--fallback-model <model>`: provider retries the request once with an
  alternate model after the primary exhausts retries on a retryable error
  (429/5xx/network); surfaced via the retry event, original error rethrown on
  double failure. No-op when unset.
- `--output-style <style>`: `concise`/`explanatory`/`learning` presets appended
  to the system prompt (combine with `--append-system-prompt`).
- `--input-format stream-json`: drive a multi-turn headless session from
  line-delimited user envelopes on stdin (Claude SDK shapes accepted), chaining
  each turn onto the prior session id, emitting the Claude-style result envelope.
- Audit honesty: dropped the phantom `manual` ApprovalMode from the CLI surface
  — it has no distinct behavior in core (aliases `confirm`) and the server WS
  rejects it; not exposed rather than faked.
- Fixed stale help text: `run --model` example (now v4), `--append-system-prompt`
  no longer labelled "not yet supported", `ask` gains `--output-style`/
  `--fallback-model`.

## 0.7.0 (2026-06-13)

### round 17: detail-audit closeout (wire core capabilities into the UIs)
- Image thumbnails end-to-end: `GET /api/raw` serves uploaded image bytes
  (hard-confined to `.seekforge/uploads/`, symlink-guarded, token-checked);
  desktop chat + composer render real `<img>` thumbnails with click-to-open
  and onError fallback.
- MCP prompts as slash commands: `mcp:<server>:<prompt>` in the TUI palette +
  `/prompts` + `GET /api/mcp/prompts`; workspace path now passed as MCP roots
  at every connect site.
- Permission UX reachable: `acceptEdits` mode in the TUI Shift+Tab cycle and a
  desktop Confirm/Accept-edits/Auto selector; allow-for-session via core's
  richer confirm result (TUI "a", desktop 3-button modal, ws protocol);
  `/compact <focus>` runs LLM-summarized compaction.
- Integrator fixes from the audit: chat surfaces (Composer/ChatItems/TabBar/
  Sidebar) tokenized so light theme works; `--append-system-prompt` wired via
  a core seam; glob tool row title; CLI completion list + `config set` help.

### round 16: detail-audit gap closure
- Engine: `glob` tool; grep parity (context lines / glob filter / files-only /
  multiline / maxMatches); run_command `cwd`. MCP prompts + roots + protocol
  2025-06-18. acceptEdits permission mode + allow-for-session confirm channel
  + `/compact` focus + llmCompactSessionNow + web_fetch extract.
- Desktop: GFM markdown (links/tables/bold/italic), code + diff syntax
  highlighting, inline image markers.
- CLI: Claude-compatible `--output-format json`/`stream-json` envelopes,
  `--system-prompt`, `--allowedTools`/`--disallowedTools`.


### round 15: polish pass (CLI output + desktop design system)

- Desktop: all 8 views adopt the whale-blue semantic tokens + ui/ primitives
  (Button/Card/Badge/Input/EmptyState) — previously they still used the old
  green zinc/emerald palette while the chrome was blue. Added consistent
  empty / loading / error states across every data view; everything now
  reads correctly in light theme too. Sidebar Todos button tokenized.
- CLI: NO_COLOR + non-TTY color gating (piped output and NO_COLOR users no
  longer get raw \x1b[ escapes); a single useColor() predicate + no-op color
  helpers across render/doctor/mcp/update/repl/version-check. Consistent
  errors via fail() → "error: <msg>" (+ hint) on stderr with non-zero exit.
  --output-format json/stream-json guaranteed byte-clean (no color, no
  notices, errors to stderr).

### round 14: CLI + desktop detail parity vs Claude Code

- Edit review before apply: write tools (write_file/apply_patch) attach a diff
  preview to their permission request; the TUI panel and desktop modal become
  "Review change → Accept / Reject" showing the colored diff before anything
  is written (per-hunk partial-apply deferred — needs a confirm-contract change).
- CLI completeness: `-p/--print` headless mode + stdin piping
  (`cat err.log | seekforge -p "explain"`); `--output-format text|json|stream-json`
  (`--json` = stream-json alias); `-c/--continue` + `--resume <id>`, `--add-dir`,
  `--max-turns`, `--verbose` on run/ask/-p; new `doctor`, `mcp add/remove`,
  `update` commands.
- Desktop polish: native OS notifications (tauri-plugin-notification) on
  permission/completion when unfocused; light/dark/system theme switcher with a
  full light token set; first-run API-key onboarding screen.

### round 9: CodeWhale absorption + style

- Multi-tab sessions: Ctrl+N opens a parallel tab, Ctrl+T cycles, /tab
  manages; every tab owns its own transcript/session/run (actions route by
  tab ID, so a run keeps streaming into its tab after you switch away);
  per-tab permission/question prompts; the tab strip shows auto-names.
- Sidebar file tree (Ctrl+E): fold/expand dirs, Enter inserts @path.
- Transcript pager (Ctrl+L): full untruncated history, g/G/PgUp/PgDn.
- Composer extras: history ghost suggestions (→ accepts), /stash [pop|list]
  draft stash.
- CodeWhale-referenced style: tighter ◆ header, segmented │ status bar,
  theme presets (deepseek/mono/solarized/matrix) with /theme picker, OSC8
  hyperlinks in supported terminals; en/zh-CN i18n layer (config locale or
  SEEKFORGE_LANG).
- Engine: image_analyze vision tool (config visionModel, OpenAI-compatible
  endpoint — closes the Ctrl+V image loop); /balance; opt-in LLM response
  cache (llmCache); plan-model routing (routing.planModel — /plan thinks on
  v4-pro, execution on flash); seekforge mcp-serve exposes SeekForge AS an
  MCP server (read-only by default, --allow-write opt-in); /handoff session
  handoff documents; error taxonomy — failures now carry actionable hints.
- Deliberately not adopted from CodeWhale: in-TUI text selection (our
  default-off mouse capture keeps native selection), hotbar/context menus
  (mouse-first UI), full LSP integration and execpolicy DSL (our
  diagnostics-via-tools and permission rules cover the need at lower
  complexity), full i18n of every string (chrome strings only for now).

### round 11: desktop parity + design system

- Rich composer: / command palette, @ file picker (new GET /api/files),
  image paste & drag-drop upload (POST /api/upload → [image #N] markers for
  image_analyze), per-workspace input history.
- Worktree parallel sessions (Claude Code desktop-style): a tab can run on
  an isolated git worktree branch (auto-registered as a workspace); merge
  back auto-checkpoints dirty work and aborts cleanly on conflicts; discard
  deletes branch + worktree.
- Core-capability UI: ↺ backtrack on user bubbles (conversation + optional
  file restore), todos drawer, per-tab model/thinking/effort controls
  (per-run WS overrides), sandbox badge, balance chip, MCP resources list,
  client-side handoff export, session search.
- Design system: semantic tokens (surface/border/accent/text tiers,
  whale-blue accent), ui/ primitives (Button/Card/Badge/Input/Modal/…),
  ⏺/⎿ tool rows, macOS overlay title bar, typography pass — referencing
  Claude desktop calm + Codex minimalism.
- Packaging: real DMG built (SeekForge_0.1.0_x64.dmg + updater payload),
  tauri-plugin-updater wired to GitHub releases; signing keys are the
  documented user step (apps/desktop/docs/RELEASING.md).

### round 8: release readiness

- `seekforge-tui` now ships inside the published `seekforge` npm package as
  a second bin (bundled like core; ink/react become real dependencies).
- DeepSeek V4 verified against the real API: /models lists only
  deepseek-v4-flash/pro for current keys; thinking + tool calling confirmed
  to coexist in one response. Default model is now `deepseek-v4-flash`
  everywhere; V4 pricing table updated with real numbers (flash 0.14/0.0028
  in, 0.28 out; pro 0.435/0.003625 in, 0.87 out per 1M).
- CLI/REPL sync: streamed thinking (dim ✻ blocks), live command output,
  micro-compaction notices, ask_user over readline, /think, and
  sandbox/compaction/thinking config — all CLI-side now (suppressed in
  --json mode).
- Server/Web sync: `reasoning.delta` WS streaming, `question.request`/
  `question.answer` round-trip (declines on timeout/disconnect), live
  command tails and thinking blocks in the workbench, config passthrough;
  SERVER-API.md updated.
- Evals expanded 4 → 14 tasks (multi-file rename, cross-module bug, missing
  tests, API migration, off-by-one, spec-to-feature, error handling, perf,
  JSON edit, TS typing), all deterministic checks, fixtures verified
  fail-pristine/pass-solved.
- Docs refreshed to 0.7.0 reality (README forms/features/limitations, TUI
  design record of rounds 3-8, roadmap Phase 9 note).

### round 7: final gaps + command depth

- Command-detail alignment round: /compact <focus> runs an LLM-summarized
  compaction steered by the focus text (no-arg stays the instant digest);
  /memory edit <file> picks any file under .seekforge/memory/ (with an
  argument picker); /clear <name> labels the old session for /sessions;
  /model notes session-only switching; /rewind and /backtrack
  cross-reference each other; /mcp explains reconnection; /doctor failing
  checks print "→ fix:" hints.
- Layout: the approval mode (⏵⏵ auto-approve / ⏸ plan mode, shift+tab hint)
  and the running shell command + background/detached counts now sit UNDER
  the input box, Claude Code-style; the top status bar stays lean.
- Text selection: mouse capture is now OFF by default so dragging selects
  text natively; /mouse (or "mouse": true) enables wheel-scrolling, with
  Shift/Option-drag still selecting while it's on.

- Live command output: run_command streams stdout/stderr while it runs —
  the TUI shows a rolling tail under the running ⏺ row (core emits
  command.output during execution; ≤200 chunks/call).
- Sandbox escalation: a sandboxed command failing with a denial-looking
  error asks once "retry WITHOUT sandbox?"; results carry sandboxEscalated.
- MCP streamable-HTTP transport: servers with `url` (+ optional `headers`
  for bearer tokens) work alongside stdio — JSON and SSE responses,
  session-id echo, timeouts. OAuth flows out of scope.
- Hook stdout semantics: userPromptSubmit stdout is injected into the task
  as <hook-context> (8K cap); preToolUse stdout JSON {"decision":
  "deny"|"allow", reason} blocks with a reason or short-circuits.
- LLM compaction (`"compaction": "llm"`): the dropped middle is summarized
  by the model (decisions/files/commands/open problems); any failure falls
  back to the mechanical digest. Manual /compact stays deterministic.
- Skills are invocable: every enabled skill appears as /skill:<id> [task]
  in the palette and help; expansion wraps the skill procedure + your task.
- Command-depth audit vs Claude Code docs: /context now shows a
  per-category breakdown (tool results / text / thinking / diffs / shell)
  with mini-gauges, free space and the compaction threshold; /usage shows
  labeled lines incl. cache-hit rate, duration, turns; /sessions adds
  relative ages; /status shows uptime. Audited the rest to parity.

### round 5: engine gaps + UI polish + DeepSeek V4

### Added (engine)
- OS-level command sandbox (opt-in `"sandbox": "workspace-write" | "restricted"`):
  seatbelt on macOS, bwrap on Linux; restricted also cuts network; hard-fails
  when requested but unavailable (never silently unsandboxed).
- DeepSeek V4 support: `deepseek-v4-flash` / `deepseek-v4-pro` with thinking
  mode + tool calling — streamed `reasoning_content` renders as a collapsible
  "✻ thought for Ns" block (Ctrl+O expands); `/think on|off|high|max` and
  config `thinking` / `reasoningEffort` control it; reasoning is never echoed
  back into requests.
- Hook events: sessionStart, userPromptSubmit (blocking), preCompact, stop,
  subagentStop, notification — alongside the existing three.
- Micro-compaction: over budget, old tool outputs are cleared first
  (`context.microcompacted` event); full digesting only if still over.
- ask_user → see round 4; subagents and detached runs can never block on it.
- `forkSession` (core) + `/fork` and `f` in the sessions picker.
- MCP resources: `listMcpResources`/`readMcpResource` over the live client
  connections; `/mcp` lists them and `@mcp:<server>:<uri>` in a message
  inlines the resource.
- GitHub workflow builtin skill (`github-issue-pr`): gh issue → branch →
  fix → tests → PR, with explicit user-approval notes for gh/git push.
- `/review`: read-only review of the uncommitted changes.

### Added (TUI UX, command experience)
- Slash-argument pickers: after the command word, the picker lists real
  candidates — `/resume` sessions (with titles), `/todo done` open items,
  `/tasks kill` running tasks, `/approve` `/think` `/model` `/memory`
  `/config` `/rewind` values; Tab fills, Enter runs immediately.
- `/help` is a grouped interactive overlay (Session / Running / Review /
  Context / Tools / Settings / Info); Enter inserts the command.
- Palette ranks by session usage (recently used commands float up) and
  matches summaries too; mistyped commands get "did you mean /x?".
- New commands vs Claude Code: `/status` (env+session snapshot), `/config
  [edit]` (effective config, key redacted), `/permissions` (rules +
  allowlists + sandbox), `/hooks`, `/release-notes`, `/bug` (report to
  clipboard). Aliases: `/q` `/h` `/cost` `/todos`.
- Fixed: TUI hooks config only merged 3 of 9 stages.

### Added (TUI UX)
- Claude Code-style tool rows: `⏺ Read(src/app.ts)` with friendly per-tool
  titles and `  ⎿  120 lines`-style result summaries; verbose keeps full
  payloads. Live activity line: spinner + elapsed seconds + live token count
  + "esc to interrupt"; per-turn summary line `✓ 34s · $0.0123 · 12.4K tok`.
- Rich markdown: tables, blockquotes, rules, links, nested bullets; diffs
  gain old/new line-number gutters; header shows the version + a rotating tip;
  context-sensitive key-hint footer.
- Cross-session todos (`/todo`, `.seekforge/todos.md`); `/add-dir` read-only
  extra roots for @ references; custom statusline (`statusLine` command,
  JSON on stdin); cost budget warnings (`costBudgetUsd`, 80%/100% once);
  `/terminal-setup` Shift+Enter instructions.

## 0.7.0 (earlier rounds)

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

- Vim mode (`/vim`, or `"vim": true`): modal composer editing — motions
  h j k l w b e 0 $ gg G, insert entries i a I A o O, edits x dd dw cw cc
  D C s S yy p, u undo; INSERT/NORMAL shown in the status bar.
- Ctrl+R reverse history search (incremental, Ctrl+R steps older) and Tab
  path completion for plain tokens (cycles candidates; `@` picker unchanged).
- Conversation backtrack: Esc Esc or `/backtrack` picks an earlier user turn,
  truncates the stored session there (core `truncateSessionAtUserTurn`) and
  refills the composer; file changes stay (use /rewind).
- `/init` (agent writes/refreshes AGENTS.md), `/doctor` (11 environment
  checks), `/skills` (installed skills incl. disabled builtins); OS
  notifications via osascript/notify-send on permission prompts and
  completion (`"notify": false` disables; bell kept as fallback).

- Run control: Ctrl+B detaches the running task to the background (chat
  continues in a fresh session; outcome arrives as a notice + bell); Ctrl+O
  verbose mode shows full diffs/shell output/tool results; Ctrl+Z suspends;
  mouse wheel scrolls the transcript.
- Per-turn checkpoints (core): file snapshots are tagged with the user turn;
  backtrack (Esc Esc) now restores files too via `rewindSessionToTurn`
  (Enter = conversation + files, `c` = conversation only).
- `ask_user` tool (core): the agent can ask a 2-6 option multiple-choice
  question; the TUI pops a panel (↑↓/1-N/Enter; Esc declines; unavailable to
  subagents and backgrounded runs).
- Custom slash commands: `.seekforge/commands/<name>.md` (project/global)
  appear in the palette; `$ARGUMENTS` substitution.
- Clipboard images: Ctrl+V saves the clipboard image to
  `.seekforge/uploads/` and inserts an `[image #N: path]` marker that
  travels with the task (ready for vision-capable models).
- Large pastes collapse to `[Pasted text #N]` placeholders, expanded on
  send; `/model` with no argument opens a picker; `/sessions` shows
  summary-based titles (core `sessionTitle`).
- Launch & environment: `-c/--continue`, `--model`, `--vim` flags; first-run
  API-key wizard; user keybinding overrides in `.seekforge/keybindings.json`;
  terminal-title updates; `seekforge completion bash|zsh`.

### Changed
- TUI keybindings are a declarative testable table (`keymap.ts`); all input
  routing (permission → overlay → composer) is centralized in one handler.
- TUI tests: 26 → 273 (editor model, history, fuzzy, file index, viewport,
  diff, capture, allowlist, surfaces, highlight, theme, keymap, export, vim,
  history-search, path-complete, backtrack, doctor, skills, notify).

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

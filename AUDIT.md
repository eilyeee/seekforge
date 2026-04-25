# TUI slash-command content audit vs Claude Code (tui-v7-audit)

Audit of SeekForge's slash-command **output/interaction content** against Claude Code's
built-ins (sources: code.claude.com/docs/en/commands and /docs/en/interactive-mode,
fetched 2026-06-12). Fixes were applied only inside the owned files
(`surfaces.ts`, `command-surfaces.ts`, `components/ContextInspector.tsx`, `format.ts`
plus their tests). Everything that needs `app.tsx` / `commands.ts` / `model.ts` is
listed as integrator hand-off with concrete suggested behavior.

## Verdict table

| Command | Claude Code content | SeekForge content | Verdict | Action |
| --- | --- | --- | --- | --- |
| /context | Colored grid, **per-category token breakdown**, optimization suggestions, capacity warnings, `all` arg | Single window gauge + usage line + item count | **Content gap** | **Fixed (partial)**: `contextBreakdown()` in surfaces.ts + ContextInspector renders per-category mini-gauges, ~token estimates (chars/4, mirrors core `estimateTokens`), item counts, free-space row, compaction threshold. Needs 1-line wiring (below). |
| /usage, /cost | Session cost, duration/API time, plan limits, per-skill/agent breakdown | One-line `formatUsage` | **Content gap** | **Fixed (partial)**: `formatUsageDetail(usage, { durationMs?, turns? })` in format.ts returns labeled multi-line block incl. cache-hit %. Status-bar one-liner unchanged. Needs wiring (below). |
| /sessions, /resume | Picker with names, age, `bg` markers | id/status/cost/task lines, no age | Content gap | **Fixed**: `formatSessionLines` now renders `2h ago` from `updatedAt` (`relativeAge` in format.ts, injectable `now` 3rd param; existing `(metas, 50)` call site unaffected). |
| /status | Settings UI: version, model, account, connectivity | Aligned label/value block (version, model, workspace, session, approval, vim, sandbox, key, cost, context, mcp…) | Cosmetic gap | **Improved**: optional `uptimeMs` → `uptime  3m 12s` row (CC's /cost shows duration). Needs wiring (below). |
| /compact | Accepts **focus instructions** argument; reports what survives | No-arg; runs `compactSessionNow`, reports dropped turns + token delta | **Content gap** | Hand-off: move `"compact"` from `NO_ARG` to `REST_ARG` in commands.ts, extend the `SlashCommand` variant with `arg?`, and pass the focus text into `compactSessionNow` (core summary prompt). |
| /memory | Pick **which memory file** to edit; auto-memory view/toggles | Lists project facts; `edit` opens `$EDITOR` on `project.md` only | Content gap | Hand-off: `/memory` could enumerate `.seekforge/memory/*.md` and take a file argument (`/memory edit <file>`); needs app.tsx handler + WORD_ARG already allows one arg. |
| /doctor | Status-icon checks; press `f` to auto-fix | ✓/✗ per-check lines + `N/M passed` summary (doctor.ts) | Near parity | None (doctor.ts not owned). Optional hand-off: a "press f to fix"-style hint or fix-prompt is an app.tsx interaction. |
| /todo(s) | Task list in status area, Ctrl+T toggle, persists across compaction | Cross-session `.seekforge/todos.md` with add/done/rm | Parity (different model, equivalent depth) | None. |
| /model | Picker w/ effort arrows, session-only `s`, re-cache confirm | Picker overlay + direct set | Cosmetic gap | Hand-off (optional): session-only switch needs app.tsx. |
| /clear | `[name]` labels the old conversation for /resume | Clears + fresh session | Cosmetic gap | Hand-off (optional): name arg = commands.ts REST_ARG + label store. |
| /mcp | Interactive list; `reconnect`/`enable`/`disable` args | Server/tool listing + resources | Interaction gap | Hand-off: subcommand args need commands.ts parsing + app.tsx actions. Listing content itself is at parity. |
| /agents, /skills | Manager UI (create/edit) | Listings with scope/mode/disabled flags | Interaction gap (content parity) | None in owned files. |
| /permissions, /hooks | Interactive editors | Read-only listings with empty-state explainers | Interaction gap (content parity) | None. |
| /config | Interactive settings UI | `key = value` listing + paths + edit hint | Interaction gap (content parity) | None. |
| /release-notes | Interactive **version picker**, all versions | First CHANGELOG section only | Content gap | Hand-off: a `sessions`-style overlay listing all `## ` headings (parseable via a `findChangelogSections` variant in command-surfaces.ts — happy to add once an overlay kind exists). |
| /rewind | Rewind code **and/or conversation** from a menu (checkpointing) | `/rewind` (files, dry-run) + `/backtrack` (conversation) split | Parity-ish (split across two commands) | None; consider cross-referencing each in the other's notice. |
| /export, /copy, /diff, /init, /vim, /terminal-setup, /plan, /approve, /think, /tasks, /help, /bug | — | — | Parity | None. |

## Integrator wiring needed (small, app.tsx only)

1. **/context**: pass the transcript to the inspector —
   `<ContextInspector … items={state.items} />` (new optional prop; renders identically without it).
2. **/usage**: replace `notice(formatUsage(stateRef.current.totalUsage))` with
   `for (const line of formatUsageDetail(stateRef.current.totalUsage, { durationMs: Date.now() - startedAtRef.current, turns: userTurnCount })) notice(line);`
   (both opts optional; a `startedAt` ref + user-item count are the only new state).
3. **/status**: pass `uptimeMs: Date.now() - startedAtRef.current` into `formatStatusLines`.
4. **/compact focus instructions**: commands.ts `REST_ARG.add("compact")` + variant
   `{ name: "compact"; arg?: string }` + pass through to compaction summary prompt.

## What changed in this branch (owned files)

- `apps/tui/src/format.ts`: added `formatDuration`, `relativeAge`, `formatUsageDetail`.
- `apps/tui/src/surfaces.ts`: `formatSessionLines` gained an age column + injectable `now`;
  added `contextBreakdown` / `ContextCategoryRow` (chars/4 per-category estimate over
  transcript items; steps/notices excluded as they never reach the model).
- `apps/tui/src/components/ContextInspector.tsx`: new optional `items` prop; renders the
  per-category breakdown with 12-col mini-gauges, free-space row and auto-compaction
  threshold when `context` is known. Backward compatible with today's props.
- `apps/tui/src/command-surfaces.ts`: `StatusInput.uptimeMs?` → `uptime` row.
- Tests extended in `format.test.ts`, `surfaces.test.ts`, `command-surfaces.test.ts`.

Tests: 519 passing (was 504, +15). `pnpm --filter @seekforge/tui typecheck` clean.

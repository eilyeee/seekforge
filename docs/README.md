# SeekForge documentation

A local-first, DeepSeek-powered coding agent: CLI, terminal UI, desktop app, and
an embeddable core. Start with the [project README](../README.md) for the pitch
and quick start; this folder holds the reference docs.

## Using SeekForge
- [Cookbook](cookbook.md) — task-oriented recipes (fix a test, refactor, review
  a diff, verify loop, MCP, skills, memory, worktrees, audits, Ark provider).
- [Migrating from Aider / Cline / Claude Code / Codex](migration.md) — concept
  mapping and what's distinctive about SeekForge.
- [CLI reference](cli-reference.md) — `run` / `ask` / `serve` and every flag
  (`--profile`, `--output-style`, `--permission-mode`, …).
- [Configuration](configuration.md) — config layers & precedence, profiles,
  permission rules, hooks (incl. the JSON output protocol), output styles,
  MCP servers, sandbox, and the TUI status line.
- [MCP](mcp.md) — Model Context Protocol servers (stdio + Streamable HTTP),
  resources, prompts, and `${ENV}` header expansion.
- [Browser / visual verification](browser.md) — the optional Playwright-backed
  `browser_navigate` / `browser_screenshot` / `browser_snapshot` /
  `browser_console` tools and the frontend verify loop.
- [LSP / precise symbol intelligence](lsp.md) — the optional language-server-backed
  `lsp_definition` / `lsp_references` / `lsp_diagnostics` tools for precise
  definitions/references/diagnostics vs. the lexical `repo_map`/`find_definition`.
- [Loop engineering](loop-engineering.md) — the autonomous run→verify→continue
  loop and its guardrails.
- [Scheduled jobs](scheduling.md) — register local cron/interval jobs
  (`seekforge schedule`), the mandatory per-run cost budget, headless safety,
  and wiring the tick into cron/launchd/systemd.
- [Event-triggered automation](automation.md) — server webhook triggers that fire
  a headless, cost-bounded run on an external event: native GitHub HMAC delivery
  or generic server-token + trigger-secret authentication.
- [Autonomous GitHub issue → PR](github.md) — `seekforge resolve <issue>`: fetch
  an issue, fix it headless on a work branch, verify, and open a draft PR. The
  agent fixes; the user's `resolve` command performs the push/PR (moat preserved).
- [Remote / isolated execution](remote.md) — the agent-runner contract and the
  Docker reference runner (`seekforge sandbox-run`): single-workspace mount,
  key-via-env, the network tradeoff, and auditing containerized runs.

## Surfaces
- [Internal embedding API (`@seekforge/core`)](sdk.md) — use the private
  workspace engine in monorepo integrations: provider factory,
  `createAgentCore`/`runTask`, the autonomous loop, and extension points. It is
  not currently a published public SDK.
- [CLI](../apps/cli/README.md) · [Terminal UI](../apps/tui/README.md) ·
  Desktop shell: [apps/desktop/src-tauri/README.md](../apps/desktop/src-tauri/README.md)
- [Server REST + WS API](../apps/server/SERVER-API.md) — the contract the
  desktop/web workbench speaks.
- Custom slash commands (frontmatter, `$ARGUMENTS`/`$1..$9`, `:` namespacing,
  `` !`shell` ``, `run_user_command`) are documented in the
  [TUI README](../apps/tui/README.md#custom-commands).

## Maintaining quality
- [Architecture](architecture.md) — package responsibilities, dependency
  direction, state ownership, internal module boundaries, and change placement.
- [Evals & the regression gate](EVALS.md) — the deterministic CI gate, running
  evals, the baseline convention, and `--fail-on-regression`.
- [Releasing](RELEASING.md) — the DMG checklist, clean-machine verification
  gate, and the updater decision.
- [Roadmap and maturity](roadmap.md) — what is production-ready, what remains
  experimental, and the next hardening priorities.

## Notes & audits
- [Low-end model audit](low-end-model-audit.md)

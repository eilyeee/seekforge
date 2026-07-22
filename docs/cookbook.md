# Cookbook

> **English** | [简体中文](cookbook.zh-CN.md)

Task-oriented recipes. Each is a **goal → steps → tips** block using only real
commands and flags. For the full flag list see the
[CLI reference](cli-reference.md); for config keys see
[Configuration](configuration.md).

All CLI commands run from inside your project. Run `seekforge init` once to
create `.seekforge/` and `AGENTS.md`, and make sure a key is set
(`DEEPSEEK_API_KEY` env var, or `seekforge config set apiKey sk-... --global`).

---

## Fix a failing test

**Goal:** hand the agent a failing test and let it drive to green.

```bash
# One-shot: describe the task, auto-approve edits.
seekforge run "the test in src/parser.test.ts is failing — find the cause and fix it" -y

# Let the agent verify its own fix before finishing (self-run on the finish turn):
seekforge config set verifyCommand "pnpm test"   # see note below — not settable, edit file instead
```

`verifyCommand` is **not** settable via `config set` — add it to
the user-owned `~/.seekforge/config.json` directly:

```json
{ "verifyCommand": "pnpm test" }
```

With `verifyCommand` set, the loop runs it automatically on the finish turn and
feeds the real result back (`autoVerify`, default on). See
[Configuration → verifyCommand](configuration.md#verifycommand).

**Tips:**
- For a hard, must-pass criterion prefer the autonomous loop (below) over a
  single `run`.
- `@path` tokens inline file contents into the task, e.g.
  `seekforge run "explain @src/parser.ts and fix @src/parser.test.ts"`.

---

## Run an autonomous verify loop (run → verify → continue)

**Goal:** keep iterating until a shell command exits 0.

CLI:

```bash
seekforge loop "make the failing suite pass" --verify "pnpm test"
seekforge loop "port the module to TS" --verify "pnpm build" --max-iters 12 --budget 1.50
seekforge loop "fix it in isolation" --verify "pnpm test" --worktree
```

`--verify <cmd>` is **required** (its exit 0 is the success criterion).
`--max-iters` defaults to 8 and is capped at 100. `--budget <usd>` stops further work when observed
cumulative usage reaches the budget; an already in-flight provider request can
make the final billed amount slightly higher. The loop is inherently autonomous
(runs in `acceptEdits`); `-y` only suppresses the auto-approve note.

The verification command uses the shared shell executor with the configured OS
sandbox and is stopped cooperatively on `Ctrl-C` or the TUI Stop action.

TUI (`seekforge` interactive): `/loop` is multi-line — the first line is the
verify command, the lines below are the task.

```
/loop pnpm test
make the failing suite pass without weakening any assertions
```

Optional TUI controls go before the verification command:

```text
/loop --max-iterations 12 --budget 1.50 pnpm test
make the failing suite pass without weakening any assertions
```

**Tips:**
- Once an agent iteration creates a session, the loop keeps its trace on
  stop/exhaustion. The orchestration state is always persisted; use
  `seekforge loop-resume <loop-id>` to continue with its prior session, spend,
  and remaining iterations. A `--worktree` checkout is retained, and resume must
  run from that directory. See [Loop engineering](loop-engineering.md).
- Add capacity without resetting history using `loop-resume --add-iters 4
  --add-budget 0.50 <loop-id>`. Use `loop-list`, `loop-show`, and `loop-delete`
  to manage records.
- Remove retained Loop worktrees with `loop-cleanup <name>`. Dirty worktrees
  require `--force`.

---

## Refactor across files

**Goal:** a multi-file change with a strong model and a plan first.

```bash
# Plan read-only, confirm, then execute in the same session:
seekforge run "extract the retry logic into a shared module and update all callers" --plan -y

# Use a stronger model just for this run:
seekforge run "rename the User type to Account everywhere" -m deepseek-v4-pro -y
```

**Tips:**
- Edits to existing files go through `apply_patch` (verbatim search/replace);
  the agent re-reads on a failed patch.
- Set `planModel` in config so `/plan` and `--plan` escalate to a stronger model
  on the same endpoint. See
  [Configuration → planModel](configuration.md#planmodel).
- In the TUI use `/plan <task>` for the same plan-confirm-execute flow.

---

## Review a diff

**Goal:** get a read-only review of uncommitted work.

TUI:

```
/diff       # show the working-tree diff
/review     # read-only review of the uncommitted changes
```

CLI:

```bash
seekforge diff                       # raw git diff
seekforge ask "review my uncommitted changes for bugs and edge cases"
```

`ask` is read-only Q&A — no writes, no command execution.

**Tips:**
- `finalizeReview` (config, default off) makes an edit run review its own diff
  before finishing, dispatching the built-in `reviewer` subagent when available.
  See [Configuration → finalizeReview](configuration.md#finalizereview).

---

## Export a session audit

**Goal:** a reviewable report of what an agent did (prompts, tool calls, files
changed, cost). Deterministic — reads the stored trace, no model calls.

```bash
seekforge sessions                       # find the session id
seekforge audit <session-id>             # markdown report to stdout
seekforge audit <session-id> -o audit.md # write to a file
seekforge audit <session-id> --json      # raw SessionAudit JSON
```

TUI: `/audit [sessionId]` writes the audit for the current (or named) session.

**Tips:**
- `seekforge replay <session-id>` re-renders the whole session to the terminal;
  `seekforge rewind <session-id>` undoes a session's file changes (`--dry-run`
  first).

---

## Work in an isolated worktree

**Goal:** let the agent work on a throwaway git checkout without touching your
tree.

TUI:

```
/worktree list
/worktree new [name]        # git worktree add under .seekforge/worktrees/<slug>, branch seekforge/<slug>
/worktree remove <slug>
```

Each worktree is a real `git worktree` on its own `seekforge/<slug>` branch
under `.seekforge/worktrees/`, ignored via the repo's `info/exclude`.

**Tips:**
- Use worktrees to run parallel experiments; merge or delete the branch when
  done. `/tab new` opens parallel sessions in the same tree.

---

## Set up an MCP server

**Goal:** expose extra tools to the agent via Model Context Protocol.

```bash
# Add a stdio server (everything after the name is the literal spawn command):
seekforge mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
seekforge mcp add -g fs npx -y @scope/server .    # -g = user config, all projects

seekforge mcp list --tools    # list servers and the tools they expose
seekforge mcp remove filesystem
```

HTTP (Streamable) servers can be declared in either layer, but trusted servers
must be added to `~/.seekforge/config.json` under `mcpServers` — see
[Configuration → mcpServers](configuration.md#mcpservers) and the
[MCP guide](mcp.md). In the TUI, `/mcp` lists servers and `/prompts` lists MCP
prompts (invoke as `/mcp:<server>:<prompt>`).

**Tips:**
- SeekForge can also *be* an MCP server: `seekforge mcp-serve` (read-only tools
  by default; `--allow-write` for trusted callers).

---

## Create a skill

**Goal:** package a reusable procedure the agent can load on demand.

```bash
seekforge skill create my-procedure     # scaffolds .seekforge/skills/my-procedure/
seekforge skill list                    # project > global > builtin
seekforge skill show my-procedure
seekforge skill import ./path/to/SKILL.md    # import Claude-style skill (-g global, -f force)
seekforge skill enable|disable|remove <id>
```

Skills carry YAML frontmatter in `SKILL.md`; the loop selects relevant ones per
task automatically. TUI: `/skills` lists installed skills.

**Tips:** see `packages/core/src/skills/` for the skill format and selection.

---

## Curate project memory

**Goal:** keep durable project facts, human-gated.

TUI:

```
/remember <fact>        # save a fact to project memory (# <fact> also works)
/memory                 # list project memory facts
/memory candidates      # review pending auto-extracted candidates
```

CLI:

```bash
seekforge memory list                    # project.md + pending candidates
seekforge memory add "build with: pnpm -w build" --type command
seekforge memory approve <candidate-id>  # mc-... id; --user for user memory
seekforge memory reject <candidate-id>
seekforge memory stats                   # extraction-quality stats
seekforge memory compact --dry-run       # collapse duplicates deterministically
```

Auto-extracted facts stay **pending** until you approve them, unless you set
`memoryAutoApproveConfidence`. See
[Configuration → memoryAutoApproveConfidence](configuration.md#memoryautoapproveconfidence).

**Tips:** `--type` is one of `command | path | convention | tech | task_pattern`.

---

## Configure a non-DeepSeek provider (Ark) with cost tracking

**Goal:** point SeekForge at Volcengine Ark (OpenAI-compatible) and still track
cost.

```bash
export ARK_API_KEY="…"
seekforge config set provider ark --global
seekforge config set model glm-5.2
```

Ark disables DeepSeek-only behaviors (thinking body, cache-hit tokens, built-in
pricing, balance). Reported cost stays `0` unless you supply `modelPricing`.
Add it to `~/.seekforge/config.json` directly (not settable via `config set`):

```json
{
  "provider": "ark",
  "model": "glm-5.2",
  "modelPricing": {
    "glm-5.2": {
      "inputCacheMissPer1M": 0.00,
      "inputCacheHitPer1M": 0.00,
      "outputPer1M": 0.00
    }
  }
}
```

Fill in real per-1M-token prices from your provider. A model listed in
`modelPricing` is always priced, re-enabling `maxCostUsd` budget tracking.
See [Configuration → Ark](configuration.md#volcengine-ark-openai-compatible)
and [modelPricing](configuration.md#modelpricing-cost-tracking-on-other-providers).

**Tips:** `seekforge models` lists DeepSeek models and pricing; `seekforge doctor`
checks your key and environment.

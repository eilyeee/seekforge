# SeekForge

**A local-first coding agent powered by DeepSeek.**

SeekForge is a coding agent for real-world projects: it reads your codebase,
understands the task, plans changes, edits files, runs verification, keeps
fixing on failure, and finally presents a reviewable diff with a summary and
token/cost usage.

```bash
cd your-project
seekforge run "修复登录按钮点击无响应的问题"
```

```txt
session 20260610T110258-c1pbi7
· skills: bugfix
→ search_text {"pattern":"login.*button"}
✓ search_text
→ read_file {"path":"src/components/LoginButton.vue"}
✓ read_file
→ apply_patch {"path":"src/components/LoginButton.vue", ...}
✓ apply_patch
● changed src/components/LoginButton.vue
→ run_command {"command":"pnpm test"}
✓ run_command
...
Tokens: 38.7K prompt (33.2K cache hit) / 6.1K completion   Cost: $0.0124
```

## Status

✅ **Step 1 — CLI** (usable today): agent loop with context compaction,
10 sandboxed tools, 5-level permission policy, session resume, streaming,
skills, reviewable project memory, optional Rust execution backend.

🚧 **Step 2 — SeekForge App** (in progress): `seekforge serve` ships a local
web workbench (React) — chat with live plan/tool/permission UI, sessions,
skills, memory review, settings. The Tauri desktop shell, self-evolution,
and an evaluation harness come after.

## Install & setup

```bash
# from npm (CLI)
npm install -g seekforge

# or from source
git clone https://github.com/eilyeee/seekforge && cd seekforge
pnpm install && pnpm typecheck && pnpm test

# configure the DeepSeek API key (one of):
seekforge config set apiKey sk-... --global     # ~/.seekforge/config.json (0600)
export DEEPSEEK_API_KEY=sk-...
```

## Commands

| Command | What it does |
| --- | --- |
| `seekforge` | **interactive session** (REPL): multi-turn conversation, `/help` for slash commands (`/new` `/sessions` `/resume` `/model` `/usage`) |
| `seekforge serve [--port 7373]` | local web UI + agent API for this workspace (127.0.0.1 only, token-protected; open the printed URL) |
| `seekforge run "<task>"` | run a development task; `-y` auto-approves safe writes/commands, `-m` overrides the model, `--json` emits JSONL events for CI |
| `seekforge ask "<question>"` | read-only Q&A (writes and commands disabled) |
| `seekforge resume <session-id> [task]` | continue a session with its full history (keeps its ask/edit mode) |
| `seekforge sessions` | list sessions with status and cost |
| `seekforge status` | project / config / last-session overview |
| `seekforge diff` | show the current git diff |
| `seekforge init` | scaffold `.seekforge/` and an `AGENTS.md` template |
| `seekforge skill list\|show <id>\|create <id>` | procedure skills (project > global > builtin) |
| `seekforge memory list\|approve <id>\|reject <id>` | review extracted facts into long-term project memory |
| `seekforge config show\|set <key> <value> [-g]` | config keys: `apiKey`, `model`, `baseUrl`, `runtimeBin`, `commandAllowlist` (comma-separated prefixes) |

`Ctrl+C` cancels a running session cooperatively (the trace is kept, so
`seekforge resume` can pick it up); a second `Ctrl+C` force-quits.
`@path` tokens in a task inline that file's content (sensitive files excluded).
The agent can also: publish a live plan checklist (`update_plan`), commit its
work (`git_commit` — push stays impossible), and fetch public docs pages
(`web_fetch` — every URL needs explicit confirmation; private addresses refused).

## How it works

- **Edits are search/replace patches** (`oldString` must match uniquely),
  applied atomically — far more reliable than unified diffs for LLMs.
- **Context manager** keeps long sessions inside the model window via
  head/tail compaction, and keeps the prompt prefix stable to hit DeepSeek
  context caching (cache-hit input is ~10x cheaper; the CLI shows your hit rate).
- **Skills** are procedure briefs (never permissions) selected per task by
  rule matching; ship your own in `.seekforge/skills/<id>/`.
- **Memory**: after each edit session one extra model call distills durable
  facts as *candidates*; nothing enters long-term memory (`.seekforge/memory/project.md`)
  until you `seekforge memory approve` it. Relevant memory is injected into
  later sessions as a short brief.
- **Sessions** are JSONL traces under `.seekforge/sessions/<id>/` —
  messages, tool calls, and events are fully auditable.

## Security model

- 5 permission levels: readonly auto-runs; writes ask (unless `-y`);
  non-allowlisted commands ask; dependency installs always ask;
  dangerous commands (`rm -rf`, `sudo`, `git push`, pipe-to-shell, `bash -c`…)
  are always refused.
- Permission prompts show the **raw command/path**, never a model paraphrase.
- Workspace sandbox (realpath containment, symlink-escape checks);
  `.env`/`*.pem`/SSH keys are unreadable; secrets are redacted from output.
- Tool results are treated as data, not instructions (prompt-injection defense),
  and memory candidates are filtered and human-reviewed before persisting.

This is **misuse protection within a project you already trust**, not an OS
sandbox — any project command (e.g. `npm test`) runs that project's code.

## Rust execution backend (optional)

The TypeScript dispatcher can delegate file/command/git execution to a small
trusted Rust binary that re-checks containment and the command denylist
(defense in depth). Permission decisions always stay in TypeScript.

```bash
cargo build --release
seekforge config set runtimeBin target/release/seekforge-runtime
```

Protocol: [`crates/runtime/PROTOCOL.md`](crates/runtime/PROTOCOL.md).

## Known limitations

- `deepseek-reasoner` is not usable as the agent model yet (no function
  calling; a fallback text protocol exists in the provider but is not wired
  into the loop).
- A resumed session keeps its original system prompt — memory/skills approved
  in between don't apply to it.
- `.seekforge/sessions/` grows unbounded (no auto-cleanup yet).
- macOS / Linux only.

## Monorepo layout

```txt
apps/cli          the seekforge CLI (published to npm)
packages/core     agent loop, provider, tools, memory, skills, runtime client
packages/shared   cross-cutting plain types
crates/runtime    seekforge-runtime (Rust execution backend)
examples/         fixture projects for end-to-end verification
```

Development: `pnpm install`, `pnpm typecheck`, `pnpm test` (TS),
`cargo test` (Rust). Conventions live in [AGENTS.md](AGENTS.md).

## Disclaimer

SeekForge is an independent project and is **not affiliated with, endorsed by,
or sponsored by DeepSeek**. "DeepSeek" is referenced only to indicate the
underlying model API used by this tool.

## License

[MIT](./LICENSE)

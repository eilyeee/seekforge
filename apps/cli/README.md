# seekforge

**A local-first coding agent powered by DeepSeek.**

SeekForge reads your codebase, plans changes, edits files with reviewable
search/replace patches, runs your tests, keeps fixing on failure, and reports
a diff with token/cost usage at the end.

```bash
npm i -g seekforge            # published to the official npm registry

seekforge                     # interactive session: the terminal UI (seekforge chat = classic REPL)
seekforge-tui                 # the terminal UI directly

cd your-project
seekforge config set apiKey sk-... --global   # DeepSeek API key
seekforge run "修复登录按钮点击无响应的问题"
```

> Released from the `v*` git tags via a provenance-signed automated publish — see
> `.github/workflows/release-npm.yml`.

## Commands

| Command | What it does |
| --- | --- |
| `seekforge` | interactive session — the TUI in a terminal (session flags such as `--resume`, `--permission-mode`, `-y`, `--add-dir`, `--settings`, `--profile` and `--mcp-config` are passed on); the classic REPL with `seekforge chat`, `--classic`, `SEEKFORGE_CLASSIC_REPL=1`, piped input, or flags the TUI does not support yet |
| `seekforge run "<task>"` | run a development task (add `-y` to auto-approve safe writes/commands) |
| `seekforge ask "<question>"` | read-only Q&A about the codebase |
| `seekforge -p "<prompt>"` | headless print mode: one run, stream to stdout, exit (reads piped stdin) |
| `seekforge resume <id> [task]` | continue a previous session with its full history |
| `seekforge sessions` / `status` | list sessions / project overview |
| `seekforge sessions show <id>` / `sessions rename <id> <title>` | describe / name a session |
| `seekforge diff` | show the current git diff |
| `seekforge doctor` | environment diagnostics (api key, node, git, runtime, mcp, editor, clipboard, OS sandbox, pdftotext, telemetry, and a proxy line when a proxy or CA bundle is configured) |
| `seekforge resolve <issue> --max-cost <usd>` | fix an issue in an isolated worktree and open a draft PR (`--wait-ci`, `--dry-run`, `--no-worktree`) |
| `seekforge resolve-review <pr> --max-cost <usd>` | address actionable PR feedback, verify, commit, and push fixes |
| `seekforge schedule add\|list\|run` | register and run local cost-bounded scheduled jobs |
| `seekforge sandbox-run "<task>"` | execute through the optional Docker runner (`--check` prints the command only) |
| `seekforge update [-y]` (alias `upgrade`) | check npm for a newer release and upgrade with the package manager that installed it |
| `seekforge init` | scaffold `.seekforge/` and `AGENTS.md` |
| `seekforge skill list\|show\|create` | manage procedure skills |
| `seekforge plugin list\|create\|install\|update\|enable\|disable\|remove` | manage digest-approved plugin bundles |
| `seekforge mcp list\|add\|remove` | list/add/remove MCP servers in config |
| `seekforge memory list\|approve\|reject` | curate long-term project memory |
| `seekforge config show\|set` | configuration (`apiKey`, `model`, `baseUrl`, `runtimeBin`) |

GitHub workflow details and safety boundaries are documented in
[`docs/github.md`](../../docs/github.md); scheduling and isolated execution are
covered by [`docs/scheduling.md`](../../docs/scheduling.md) and
[`docs/remote.md`](../../docs/remote.md).

### Flags for `run` / `ask` / `-p`

| Flag | Effect |
| --- | --- |
| `-y, --yes` | auto-approve write/execute permissions (env-level still asks) |
| `-m, --model <model>` | override the model |
| `--output-format <fmt>` | `text` (default, human), `json` (one final object), `stream-json` (one event/line) |
| `--json` | back-compat alias for `--output-format stream-json` |
| `-c, --continue` | resume the most recent session |
| `--resume <id>` | resume a specific session |
| `--add-dir <path>` | grant a directory outside the project: the file tools may read and write there under the same prompts and rules, and `@path` references resolve there (repeatable; see [Additional directories](../../docs/cli-reference.md#additional-directories)) |
| `--max-turns <n>` | cap the number of agent turns |
| `--verbose` | print full tool args and results instead of a quiet summary |
| `--fork-session` | with `-c`/`--resume`: continue in a copy of the session |
| `--session-id <id>` | start the new session under this id (a UUID works) |
| `--system-prompt-file` / `--append-system-prompt-file <path>` | replace / extend the system prompt from a file |
| `--agents '<json>'` | subagents for this run only (Claude Code's `{"id": {"description", "prompt", …}}` shape, including `disallowedTools`, `permissionMode`, `isolation`, `skills`, `effort`, `mcpServers` and `hooks`) |
| `--debug [filter]` | internal detail on stderr (`--debug=api,tool`, `--debug='!command'`) |
| `--json-schema '<schema>'` | also produce a JSON value validating against the schema (`structured_output`) |
| `--worktree [name]` | (`run`, `-p`) run in a new retained git worktree and print where the changes are |

Most of these also apply to the interactive session. Full reference:
[`docs/cli-reference.md`](../../docs/cli-reference.md).

### Interactive REPL

`seekforge chat` answers `/help`; `!<command>` runs a shell command in the
workspace and carries its output into your next message; `/compact <focus>`
has the model summarize around a focus (your compaction hooks run, and may
cancel it); `/think low|medium|high|max` sets the reasoning effort;
`/rename <title>` names the session. A custom command file named like a
built-in is ignored. Background subagents live as long as the session.
Permission prompts accept `y`, `a` (this session), `n`, or `n: <reason>` to tell
the agent why.

### Headless / piped usage

```bash
seekforge -p "summarize the changes in this repo"      # print mode, then exit
cat err.log | seekforge -p "explain this error"        # stdin appended to the prompt
cat task.md  | seekforge -p                             # stdin IS the whole prompt
seekforge -p "fix the failing test" --output-format json -y
```

Prompt precedence: an inline prompt and piped stdin are **both** used — the
inline prompt comes first, then the piped input under a `--- piped input ---`
fence. With only stdin, stdin is the entire prompt. Machine output formats
(`json` / `stream-json`) disable colored streaming and interactive prompts, so
pair them with `-y`.

### MCP servers

```bash
seekforge mcp add fs npx -y @modelcontextprotocol/server-filesystem .   # add (project)
seekforge mcp add -g github npx @modelcontextprotocol/server-github      # add (global ~/.seekforge)
seekforge mcp add --transport http -g --trust docs https://docs.example/mcp  # remote, trusted
seekforge mcp import                                                     # copy from Claude Desktop / Code
seekforge mcp list --tools                                               # list + tool descriptions
seekforge mcp approve fs                                                 # let a project server connect here
seekforge mcp remove fs                                                  # remove
```

Options go before the server name; everything after it is the command + its
args verbatim (so its own flags like `-y` are kept). New servers are not
connected during Agent startup until someone vouches for them: a server in
`~/.seekforge/config.json` needs `"trusted": true` (or `mcp add --trust`), and a
server the checkout defines — `.seekforge/config.json`, `config.local.json`, or
Claude Code's `.mcp.json` — needs `seekforge mcp approve <name>` for this
workspace. See [docs/mcp.md](../../docs/mcp.md).

### Updating

`seekforge update` checks the npm registry, works out whether this copy was
installed with npm, pnpm or Volta, prints that manager's upgrade command
(pointed explicitly at `https://registry.npmjs.org/`) and runs it once you
confirm (`-y` skips the question). An install it cannot place — npx, yarn, bun,
a version manager it does not recognize — only gets the command to run by hand,
because running the wrong manager against a global install can corrupt it.

## Safety model

- Every tool call passes schema validation and a 5-level permission policy;
  dangerous commands (`rm -rf`, `sudo`, `git push`, pipe-to-shell…) are always
  refused, dependency installs always ask.
- Permission prompts show the raw command/path, never a model paraphrase.
- File access is sandboxed to the workspace; `.env`/keys are unreadable.
- All sessions are traced to `.seekforge/sessions/` as JSONL — fully auditable.

This is misuse protection within a project you already trust, not an OS
sandbox: any project command can run arbitrary code from that project.

## Notes

- Model: `deepseek-v4-flash` (default). `deepseek-chat` and `deepseek-reasoner`
  are deprecated (`deepseek-reasoner` has no function calling). Run
  `seekforge models` to list current models.
- Docs, source, and the optional Rust execution backend:
  https://github.com/eilyeee/seekforge

## Disclaimer

SeekForge is an independent project, **not affiliated with DeepSeek**.

MIT © eilyeee

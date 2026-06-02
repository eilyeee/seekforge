# seekforge

**A local-first coding agent powered by DeepSeek.**

SeekForge reads your codebase, plans changes, edits files with reviewable
search/replace patches, runs your tests, keeps fixing on failure, and reports
a diff with token/cost usage at the end.

```bash
npm i -g seekforge            # published to the official npm registry

seekforge                     # the CLI
seekforge-tui                 # the terminal UI

cd your-project
seekforge config set apiKey sk-... --global   # DeepSeek API key
seekforge run "修复登录按钮点击无响应的问题"
```

> Released from the `v*` git tags via a provenance-signed automated publish — see
> `.github/workflows/release-npm.yml`.

## Commands

| Command | What it does |
| --- | --- |
| `seekforge run "<task>"` | run a development task (add `-y` to auto-approve safe writes/commands) |
| `seekforge ask "<question>"` | read-only Q&A about the codebase |
| `seekforge -p "<prompt>"` | headless print mode: one run, stream to stdout, exit (reads piped stdin) |
| `seekforge resume <id> [task]` | continue a previous session with its full history |
| `seekforge sessions` / `status` | list sessions / project overview |
| `seekforge diff` | show the current git diff |
| `seekforge doctor` | environment diagnostics (api key, node, git, runtime, mcp, editor, clipboard) |
| `seekforge update` (alias `upgrade`) | check npm for a newer release and print the install command |
| `seekforge init` | scaffold `.seekforge/` and `AGENTS.md` |
| `seekforge skill list\|show\|create` | manage procedure skills |
| `seekforge mcp list\|add\|remove` | list/add/remove MCP servers in config |
| `seekforge memory list\|approve\|reject` | curate long-term project memory |
| `seekforge config show\|set` | configuration (`apiKey`, `model`, `baseUrl`, `runtimeBin`) |

### Flags for `run` / `ask` / `-p`

| Flag | Effect |
| --- | --- |
| `-y, --yes` | auto-approve write/execute permissions (env-level still asks) |
| `-m, --model <model>` | override the model |
| `--output-format <fmt>` | `text` (default, human), `json` (one final object), `stream-json` (one event/line) |
| `--json` | back-compat alias for `--output-format stream-json` |
| `-c, --continue` | resume the most recent session |
| `--resume <id>` | resume a specific session |
| `--add-dir <path>` | extra read-only root whose `@path` references resolve (repeatable) |
| `--max-turns <n>` | cap the number of agent turns |
| `--verbose` | print full tool args and results instead of a quiet summary |

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
seekforge mcp list --tools                                               # list + tool descriptions
seekforge mcp remove fs                                                  # remove
```

Everything after the server name is the command + its args verbatim (so its own
flags like `-y` are kept). New servers are **untrusted** by default — set
`"trusted": true` on the entry in `.seekforge/config.json` to auto-approve their
tools with `-y`.

### Updating

`seekforge update` only **checks** the npm registry and prints the install
command (`npm i -g seekforge`); it never self-mutates the global install,
because that binary may be owned by root or a version manager (npm/pnpm/volta/
asdf/brew) and replacing the running binary mid-process is unsafe.

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

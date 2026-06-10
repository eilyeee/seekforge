# seekforge

**A local-first coding agent powered by DeepSeek.**

SeekForge reads your codebase, plans changes, edits files with reviewable
search/replace patches, runs your tests, keeps fixing on failure, and reports
a diff with token/cost usage at the end.

```bash
npm install -g seekforge

cd your-project
seekforge config set apiKey sk-... --global   # DeepSeek API key
seekforge run "修复登录按钮点击无响应的问题"
```

## Commands

| Command | What it does |
| --- | --- |
| `seekforge run "<task>"` | run a development task (add `-y` to auto-approve safe writes/commands) |
| `seekforge ask "<question>"` | read-only Q&A about the codebase |
| `seekforge resume <id> [task]` | continue a previous session with its full history |
| `seekforge sessions` / `status` | list sessions / project overview |
| `seekforge diff` | show the current git diff |
| `seekforge init` | scaffold `.seekforge/` and `AGENTS.md` |
| `seekforge skill list\|show\|create` | manage procedure skills |
| `seekforge memory list\|approve\|reject` | curate long-term project memory |
| `seekforge config show\|set` | configuration (`apiKey`, `model`, `baseUrl`, `runtimeBin`) |

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

- Model: `deepseek-chat` (default). `deepseek-reasoner` is not supported yet
  (no function calling).
- Docs, source, and the optional Rust execution backend:
  https://github.com/eilyeee/seekforge

## Disclaimer

SeekForge is an independent project, **not affiliated with DeepSeek**.

MIT © eilyeee

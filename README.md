# SeekForge

**A local-first coding agent powered by DeepSeek.**

SeekForge is a coding agent for real-world projects: it reads your codebase,
understands the task, plans changes, edits files, runs verification, keeps
fixing on failure, and finally presents a reviewable diff with a summary.

## Roadmap

```txt
Step 1: SeekForge CLI   — a coding agent for your terminal
Step 2: SeekForge App   — a Tauri-based desktop agent workbench
```

## Features (planned)

- **Local-first** — execution and data stay on your machine; irrelevant files are never uploaded by default
- **Cost-aware** — built-in token/cost tracking, optimized for DeepSeek context caching
- **Fully reviewable** — every change is presented as a diff; dangerous commands are denied by default
- **Extensible** — project-level AGENTS.md, memory, and skills, with auditable self-evolution

## Usage (under development)

```bash
seekforge run "Fix the unresponsive login button"
```

Prefer a shorter command? Set up your own alias:

```bash
alias sf=seekforge
```

## Status

🚧 Early development. No usable release yet.

## Disclaimer

SeekForge is an independent project and is **not affiliated with, endorsed by,
or sponsored by DeepSeek**. "DeepSeek" is referenced only to indicate the
underlying model API used by this tool.

## License

[MIT](./LICENSE)

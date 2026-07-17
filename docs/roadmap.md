# Roadmap and capability maturity

> **English** | [简体中文](roadmap.zh-CN.md)

SeekForge already has a broad local-first coding-agent surface. This roadmap
separates shipped capability from production maturity so implemented features
are not repeatedly treated as missing. Status reflects the repository today,
not a promise of API stability.

## Product position

- Local-first by default, with auditable JSONL traces.
- DeepSeek-first cost visibility, including cache-hit token accounting.
- Strong permission boundaries with raw command/path prompts.
- Reviewable search/replace patches, rewind, worktrees, and human-gated memory.
- Chinese-friendly CLI, TUI, desktop, and documentation workflows.

## Capability maturity

| Capability | Status | Current boundary / next step |
| --- | --- | --- |
| Core agent loop, CLI, TUI, session traces, permissions | Production-ready foundation | Continue boundary regression testing and real-project dogfooding. |
| Desktop and local web workbench | Implemented, maturing | Security Center, MCP editing, team planning, and historical subagent replay ship; expand signed cross-platform packaging. |
| DeepSeek provider and cost accounting | Production-ready foundation | Main, compaction, and memory-extraction calls share accounting; preserve provider-specific token/cache semantics. |
| Provider presets / OpenAI-compatible endpoints | Implemented, maturing | Add compatibility fixtures per provider; do not claim identical tool/thinking behavior. |
| Memory, skills, hooks, MCP, subagents | Implemented, maturing | Exposure/retrieval metrics and HTTP token refresh ship; complete interactive OAuth and long-lived HTTP streams. |
| Worktrees and isolated execution | Implemented, maturing | Make worktree isolation the default for parallel issue/PR jobs. |
| `seekforge resolve` issue-to-draft-PR | Implemented, maturing | Existing-branch resume and one bounded CI-log repair ship; expand provider/host compatibility fixtures. |
| Scheduled jobs, webhooks, and background runs | Implemented, security-sensitive | Persistent run ledger, history, cancellation, retry backoff, and WS replay ship; add retention controls. |
| Browser / visual verification | Implemented, optional | Real Chromium integration CI ships; expand browser/platform coverage while preserving private-network restrictions. |
| Rust runtime and Docker runner | Implemented, optional | Weekly real-binary/container gates ship; expand the platform matrix and release smoke coverage. |
| Eval harness | Implemented | Real Loop/resume/memory scenarios, paired multi-sample A/B, CI history restoration, and trend reports ship. |
| `@seekforge/core` embedding API | Internal / experimental | Package is private and source-exported; define build, semver, and compatibility policy before public SDK release. |
| VS Code / JetBrains integration | Not implemented | Start with a thin client over the existing REST/WS server contract. |
| Remote/team execution service | Design-stage | Stabilize a self-hosted runner contract without weakening local-first defaults. |

## Near-term priorities

1. Produce signed updater artifacts and add Linux/Windows clean-install Desktop
   smoke jobs once platform signing credentials are available.
2. Add run-ledger/event retention, compaction, and operator controls before
   enabling long-lived remote runners by default.
3. Expand real-project lifecycle eval fixtures and preserve enough CI trend
   history to detect slow cost/quality drift across releases.
4. Complete interactive OAuth authorization and long-lived Streamable HTTP MCP
   notification/request handling; refresh-token operation already ships.
5. Improve provider compatibility fixtures while keeping DeepSeek-specific cost
   and cache-hit reporting first class.
6. Build a thin VS Code bridge over the versioned `seekforge serve` contract for chat, diffs,
   permissions, session resume, and `@file` context.
7. Decide whether to publish `@seekforge/core`; if yes, add compiled artifacts,
   supported entry points, examples, semver policy, and API compatibility tests.

## Documentation priorities

- Keep task cookbooks and migration guides aligned with shipped behavior.
- Mark optional and experimental surfaces explicitly instead of presenting them
  as universally installed or stable.
- Keep the project README concise and place operational/security details here in
  `docs/`.

## Non-goals for the next phase

- Do not dilute the local-first security model to chase cloud features early.
- Do not hide cost or token accounting behind generic provider abstractions.
- Do not publish an SDK before its distribution and compatibility contract exist.
- Do not add integrations that cannot be audited through normal session traces.

## Useful comparison references

- [Aider](https://github.com/Aider-AI/aider)
- [Cline](https://github.com/cline/cline)
- [OpenHands](https://github.com/All-Hands-AI/OpenHands)
- [Roo Code](https://github.com/RooCodeInc/Roo-Code)

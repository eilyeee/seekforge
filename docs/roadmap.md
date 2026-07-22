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
| Desktop and local web workbench | Implemented, maturing | Native macOS, Linux, and Windows package builds ship; updater/platform signing and clean-install smoke tests still require release credentials. |
| DeepSeek provider and cost accounting | Production-ready foundation | Main, compaction, and memory-extraction calls share accounting; preserve provider-specific token/cache semantics. |
| Provider presets / OpenAI-compatible endpoints | Implemented, maturing | Add compatibility fixtures per provider; do not claim identical tool/thinking behavior. |
| Memory, skills, hooks, MCP, subagents | Implemented, maturing | Exposure/retrieval metrics, OAuth token refresh, and long-lived HTTP notification/request streams ship; interactive initial OAuth authorization remains frontend-owned. |
| Worktrees and isolated execution | Implemented | Writable background and webhook jobs default to worktree isolation in git repositories, with explicit workspace/required-worktree modes. |
| `seekforge resolve` issue-to-draft-PR | Implemented, maturing | Existing-branch resume and one bounded CI-log repair ship; expand provider/host compatibility fixtures. |
| Scheduled jobs, webhooks, and background runs | Implemented, security-sensitive | Persistent run ledger, cancellation, replay cursors, and configurable count/age retention ship; keep hardening external delivery operations. |
| Browser / visual verification | Implemented, optional | Real Chromium integration CI ships; expand browser/platform coverage while preserving private-network restrictions. |
| Rust runtime and Docker runner | Implemented, optional | Weekly real-binary/container gates ship; expand the platform matrix and release smoke coverage. |
| Eval harness | Implemented | Real Loop/resume/memory scenarios, paired multi-sample A/B, CI history restoration, trend reports, and source-tagged dogfood regressions ship. |
| `@seekforge/core` embedding API | Internal by policy | The 0.x package stays private; [publication exit criteria](core-package-policy.md) define compiled artifacts, exports, semver, consumer tests, examples, and security docs. |
| VS Code / JetBrains integration | VS Code bridge implemented; JetBrains pending | Thin VS Code client ships over the REST/WS contract with chat, diff, raw permission review, session resume, questions, and `@file` context. |
| Remote/team execution service | Design-stage | Stabilize a self-hosted runner contract without weakening local-first defaults. |

## Near-term priorities

1. Produce signed updater artifacts and add cross-platform clean-install Desktop
   smoke jobs once platform signing credentials are available; native packages already build in CI.
2. Expand real-project lifecycle eval fixtures and preserve enough CI trend
   history to detect slow cost/quality drift across releases.
3. Complete interactive initial OAuth authorization for remote MCP servers;
   refresh-token operation and long-lived Streamable HTTP handling already ship.
4. Improve provider compatibility fixtures while keeping DeepSeek-specific cost
   and cache-hit reporting first class.
5. Harden and package the VS Code bridge, then evaluate a JetBrains client over the same contract.
6. Revisit `@seekforge/core` publication only after its documented exit criteria are met.

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

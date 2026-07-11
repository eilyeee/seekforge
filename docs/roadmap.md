# Roadmap and capability maturity

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
| Desktop and local web workbench | Implemented, maturing | Expand end-to-end packaging and clean-install smoke coverage. |
| DeepSeek provider and cost accounting | Production-ready foundation | Preserve provider-specific token/cache semantics as model support expands. |
| Provider presets / OpenAI-compatible endpoints | Implemented, maturing | Add compatibility fixtures per provider; do not claim identical tool/thinking behavior. |
| Memory, skills, hooks, MCP, subagents | Implemented, maturing | Improve examples, lifecycle tests, and failure diagnostics. |
| Worktrees and isolated execution | Implemented, maturing | Make worktree isolation the default for parallel issue/PR jobs. |
| `seekforge resolve` issue-to-draft-PR | Implemented, maturing | Worktree isolation, CI waiting, and review fixes ship; add failure-log feedback and branch resume. |
| Scheduled jobs and webhook-triggered sessions | Implemented, security-sensitive | Harden operational persistence; GitHub uses HMAC, delivery dedupe, and an event whitelist. |
| Browser / visual verification | Implemented, optional | Exercise real Playwright browsers in integration CI; confirmed loopback is allowed, other private networks are blocked. |
| Rust runtime and Docker runner | Implemented, optional | Add non-skipped integration gates with real binaries/containers. |
| Eval harness | Implemented | Publish periodic reports and grow real-world regression fixtures. |
| `@seekforge/core` embedding API | Internal / experimental | Package is private and source-exported; define build, semver, and compatibility policy before public SDK release. |
| VS Code / JetBrains integration | Not implemented | Start with a thin client over the existing REST/WS server contract. |
| Remote/team execution service | Design-stage | Stabilize a self-hosted runner contract without weakening local-first defaults. |

## Near-term priorities

1. Add release-artifact smoke tests: install the packed CLI in a clean
   environment and verify CLI/TUI/assets/cross-package exports on Node 20 and 22.
2. Add optional integration CI that launches Playwright, the Rust runtime, and
   the Docker runner rather than only testing definitions and error paths.
3. Complete the PR feedback loop with bounded hosted CI failure-log repair and
   existing-branch resume.
4. Expand dogfooding fixtures and publish scheduled eval reports with pass rate,
   cost, token usage, and failure details.
5. Improve provider compatibility fixtures while keeping DeepSeek-specific cost
   and cache-hit reporting first class.
6. Build a thin VS Code bridge over `seekforge serve` for chat, diffs,
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

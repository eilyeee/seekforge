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
| Autonomous Loop and Graph engineering | Implemented, maturing | Safe-boundary adaptive scheduling, desktop authoring/simulation, gray-release controls, operational diagnostics, versioned decision evidence, burn-rate freeze control, renewable executor fencing, and signed CAS provenance ship. Durable control, external signals, evidence, run comparison, and the template registry now reach the CLI and the TUI, not only REST; the deterministic handler catalogue covers definition-only workflows. Next: close the Graph `loop`-node gap below, then expand real-provider and real-project coverage. |
| Loop DAG → Engineering Graph convergence | Deprecation window open, engines not merged | `seekforge loop-dag export-graph` converts a DAG deterministically and refuses any definition it cannot make behave identically. The Loop DAG contract is frozen: new orchestration capability lands in the Graph. The `loop`-node gap that blocked merging is closed: `loopOptions`, `verifierId`, dependency-output injection, `outputPaths`, `budgetWeight`, `predictiveBudget` and per-node failure policy all exist on the Graph now. Phase 1 has shipped: `loop-dag` and `loop-dag-resources` announce the deprecation window on stderr and everything keeps working, including resume. Phase 2 removes `loop-dag`, `loop-dag-resources`, `export-graph` and `packages/core/src/agent/loop-dag.ts` in the next major release — not the rest of the flat `loop-*` family, which manages single Loops and outlives the DAG. Two things gate Phase 2: `.seekforge/loop-dags/` checkpoints in the field must no longer be expected to resume, and `loop-speculate` must be ported off `runLoopDag` onto a Graph fan-out of Loop nodes with a shared weighted budget — it is the last non-DAG caller of the engine. |
| Desktop and local web workbench | Implemented, maturing | Native macOS, Linux, and Windows package builds ship; updater/platform signing and clean-install smoke tests still require release credentials. |
| DeepSeek provider and cost accounting | Production-ready foundation | Main, compaction, and memory-extraction calls share accounting; preserve provider-specific token/cache semantics. |
| Provider presets / OpenAI-compatible endpoints | Implemented, maturing | Add compatibility fixtures per provider; do not claim identical tool/thinking behavior. |
| Memory, skills, hooks, MCP, subagents | Implemented, maturing | Exposure/retrieval metrics, long-lived HTTP notification/request streams, and interactive initial OAuth authorization (`seekforge mcp login`, PKCE, credentials stored outside config) all ship. |
| Worktrees and isolated execution | Implemented | Writable background and webhook jobs default to worktree isolation in git repositories, with explicit workspace/required-worktree modes. |
| `seekforge resolve` issue-to-draft-PR | Implemented, maturing | Existing-branch resume and bounded CI-log repair ship; Loop PR delivery now offers the same bounded check-and-repair closure. Expand provider/host compatibility fixtures. |
| Scheduled jobs, webhooks, and background runs | Implemented, security-sensitive | Persistent run ledger, cancellation, replay cursors, and configurable count/age retention ship; keep hardening external delivery operations. |
| Browser / visual verification | Implemented, optional | Real Chromium integration CI ships; expand browser/platform coverage while preserving private-network restrictions. |
| Rust runtime and Docker runner | Implemented, optional | Weekly real-binary/container gates ship; expand the platform matrix and release smoke coverage. |
| Eval harness | Implemented | Real Loop/resume/memory scenarios, paired multi-sample A/B, CI history restoration, Desktop trend visualization, source-tagged dogfood regressions, and provenance-bearing ecosystem/execution/fault matrices with CI drift gates ship. A `graph` runner drives the real Graph engine, and five tasks now grade the control plane (multi-node, gate approval, rerun-with-descendants, wait/signal, continue-on-failure). Baseline re-recorded 2026-08-11 at 68 tasks x 3 samples: 203/204. |
| `@seekforge/core` embedding API | Internal by policy | The 0.x package stays private; [publication exit criteria](core-package-policy.md) define compiled artifacts, exports, semver, consumer tests, examples, and security docs. |
| VS Code / JetBrains integration | VS Code client shipped (chat + read-only Loop panel); JetBrains pending | Thin VS Code client ships as a versioned .vsix release asset: chat with tool activity, diff-document permission review with per-hunk approval, cost/cache readout, session resume, questions, `@file` context, memory-candidate review, and readable session transcripts. Marketplace publishing stays manual (publisher token). |
| Remote/team execution service | Design-stage; single-operator remote execution ships | Graph `remote` nodes now run on the Docker and ssh runners, registered only from `~/.seekforge/graph-executors.json` so a cloned repository cannot name a host. Remaining work is the multi-operator case: stabilize a self-hosted runner contract without weakening local-first defaults. |

## Near-term priorities

1. Produce signed updater artifacts and add cross-platform clean-install Desktop
   smoke jobs once platform signing credentials are available; native packages already build in CI.
2. Expand real-project lifecycle eval fixtures and preserve enough CI trend
   history to detect slow cost/quality drift across releases; the baseline is
   current as of 2026-08-11 (68 tasks, three samples, 203/204).
3. Finish retiring the Loop DAG: the capability gap is closed and the
   deprecation window is open. What is left is porting `loop-speculate` off the
   DAG engine and deleting it once field checkpoints need not resume. Then expand real-provider coverage for the Loop/Graph control plane;
   the wire dialects of OpenAI-compatible endpoints are normalized and
   fixture-pinned.
4. Improve provider compatibility fixtures while keeping DeepSeek-specific cost
   and cache-hit reporting first class.
5. Evaluate a JetBrains client over the same contract; the VS Code client now ships as a versioned .vsix release asset.
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

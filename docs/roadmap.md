# Roadmap and competitive gaps

This note captures the product direction after Step 2. SeekForge already has a
usable local-first loop, CLI/TUI/desktop surfaces, JSONL session traces, memory,
skills, subagents, MCP, worktrees, and an eval harness. The next phase is less
about proving that an agent can edit code, and more about making it dependable
enough to become a daily driver.

## Positioning

SeekForge should keep its sharpest distinction:

- Local-first by default, with auditable JSONL traces.
- DeepSeek-first cost visibility, including cache-hit token accounting.
- Strong permission boundaries and raw command/path prompts.
- Reviewable search/replace patches, rewind, worktrees, and human-gated memory.
- Chinese-friendly workflows and documentation.

The goal is not to copy every large agent platform. The goal is to become the
trustworthy local coding agent that developers can leave open all day.

## Competitive gaps

These are the main gaps versus mature open-source coding agents such as Aider,
Cline, OpenHands, and Roo Code.

### IDE integration

SeekForge has CLI, TUI, a local web workbench, and a Tauri shell, but no first
class VS Code or JetBrains integration yet. Editor-native agents win adoption
because they live next to the user's diagnostics, file tree, inline diffs, and
muscle memory.

Recommended direction:

- Start with a thin VS Code bridge that talks to `seekforge serve`.
- Reuse the existing REST/WS API instead of creating a second agent stack.
- Surface chat, inline diff review, permission prompts, session resume, and
  `@file` context first.

### Provider and model breadth

SeekForge is intentionally DeepSeek-first. That is a good product wedge, but
many open-source agents now support Anthropic, OpenAI, Google, OpenRouter,
Bedrock, Azure/GCP, Ollama, LM Studio, and generic OpenAI-compatible endpoints.

Recommended direction:

- Keep DeepSeek as the default and best-supported provider.
- Harden a provider interface that can support OpenAI-compatible APIs without
  weakening DeepSeek-specific accounting.
- Treat cost, cache-hit metrics, thinking support, and tool-calling differences
  as provider capabilities rather than global assumptions.

### GitHub and PR workflow

SeekForge can inspect diffs, rewind sessions, commit locally, and work in
isolated worktrees. It does not yet cover the full issue-to-PR loop.

Recommended direction:

- Add first-class flows for issue triage, branch creation, commit, push, draft
  PR creation, CI inspection, and review-comment fixes.
- Keep push/PR actions explicit and human-approved.
- Make worktree sessions the default execution model for parallel PR work.

### Automation and event triggers

SeekForge has `loop` and a server API, but not a durable automation product
surface. Competing tools increasingly support scheduled agents, webhook
triggers, Slack/Linear/GitHub integrations, and recurring codebase reports.

Recommended direction:

- Start with local scheduled jobs backed by the existing server and session
  trace format.
- Add event-triggered jobs for GitHub issues, PR comments, CI failures, and
  dependency update checks.
- Make every automation produce a normal auditable session.

### Remote and team execution

SeekForge's local-first stance is a strength, but teams eventually need remote
machines, long-running tasks, and shared review surfaces.

Recommended direction:

- Keep single-user local mode simple.
- Define an agent-runner contract that can execute the same session on a local
  machine, a remote workstation, a Docker container, or a VM.
- Avoid cloud lock-in; prefer self-hosted runners before managed service work.

### Browser and visual verification

SeekForge supports image attachments and codebase work, but it does not yet
have a polished browser-testing loop for frontend tasks.

Recommended direction:

- Add Playwright-backed page inspection, screenshots, console/network capture,
  and visual smoke checks.
- Integrate browser verification with `loop` so frontend fixes can iterate on
  both tests and rendered UI.
- Keep screenshots and browser logs in the session trace for review.

### SDK and plugin ecosystem

SeekForge exposes `@seekforge/core` internally and supports skills, hooks, MCP,
and subagents, but the extension story is not yet packaged as a developer
platform.

Recommended direction:

- Document a stable programmatic API for embedding the agent loop.
- Provide examples for custom tools, lifecycle hooks, policy gates, and
  server-side integrations.
- Treat MCP and skills as user-facing extensibility, and the core SDK as
  developer-facing extensibility.

### Public evals and proof

SeekForge has a real eval harness, which is a strong foundation. The missing
piece is making the results easy for outsiders to trust.

Recommended direction:

- Publish periodic eval reports with pass rate, cost, token use, and failures.
- Add larger real-world fixtures and regression tasks from dogfooding.
- Track known weaknesses openly instead of only publishing wins.

### Documentation and onboarding depth

The current docs explain the system, but the project still needs more learning
material for new users.

Recommended direction:

- Add task cookbooks: bug fix, refactor, test repair, PR review, frontend fix,
  MCP setup, skill creation, and memory curation.
- Add migration/comparison pages for users coming from Aider, Cline, Claude
  Code, Codex, or OpenHands.
- Keep the README concise; put deeper workflow guidance under `docs/`.

## Suggested priority

1. Real-world dogfooding and eval expansion.
2. VS Code bridge on top of `seekforge serve`.
3. GitHub PR and CI workflows.
4. Provider abstraction beyond DeepSeek while preserving DeepSeek-first polish.
5. Local scheduled automations and webhook-triggered sessions.
6. Browser/visual verification for frontend tasks.
7. Public SDK examples and extension documentation.
8. Remote/self-hosted runner contract for team use.

## Non-goals for the next phase

- Do not dilute the local-first security model to chase cloud features early.
- Do not hide cost or token accounting behind generic provider abstractions.
- Do not make the README a full strategy document.
- Do not add integrations that cannot be audited through normal session traces.

## Useful comparison references

- [Aider](https://github.com/Aider-AI/aider)
- [Cline](https://github.com/cline/cline)
- [OpenHands](https://github.com/All-Hands-AI/OpenHands)
- [Roo Code](https://github.com/RooCodeInc/Roo-Code)

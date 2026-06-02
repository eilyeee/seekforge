# Lower-Capability Model Bug Audit Procedure

This document is a step-by-step testing procedure for auditing SeekForge with a lower-capability model. Run each section as a separate task. Do not ask the model to audit the whole repository in one prompt.

## 0. Baseline Collection

Run these commands first and save the output:

```sh
git status --short
git diff --stat
pnpm typecheck
pnpm test
pnpm audit --audit-level moderate
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

For every failed command, record:

```text
Command:
Exit code:
Failure type: assertion failure / environment failure / command misuse / dependency audit
Key output:
Likely affected area:
```

## 1. Config Wiring Audit

Check one config field at a time.

Fields to test:

- `model`
- `planModel`
- `escalateOnFailure`
- `hooks`
- `mcpServers`
- `permissionRules`
- `sandbox`
- `runtimeBin`
- `thinking`
- `reasoningEffort`

Files to inspect:

```text
README.md
docs/configuration.md
apps/cli/src/config.ts
apps/cli/src/agent-factory.ts
apps/tui/src/config.ts
apps/tui/src/agent/factory.ts
apps/server/src/config.ts
apps/server/src/agent.ts
packages/core/src/agent/loop.ts
packages/core/tests/**/*
```

Test procedure:

1. Find the field in README/docs.
2. Find the field in each entry-point config type.
3. Check whether `loadConfig` reads and merges it.
4. Check whether the entry-point factory passes it to `createAgentCore`.
5. Check whether core uses it.
6. Check whether tests cover the full path.
7. Report any entry point where the chain is broken.

Prompt:

```text
Only audit config wiring for this field:
<field>

Check this path:
docs -> config type -> loadConfig -> factory -> createAgentCore -> core usage -> tests.

Output:
- Field:
- Entry point:
- Chain status: complete / broken / uncertain
- Broken step:
- Evidence: file path + line number
- Trigger condition:
- User impact:
- Missing test:
```

## 2. Cross-Entry Consistency Audit

Check one capability at a time.

Capabilities to test:

- Hooks
- Plan model routing
- Failure escalation
- Sandbox
- MCP servers
- Permission rules
- Runtime backend
- Thinking/reasoning controls

Files to inspect:

```text
apps/cli/src/**
apps/tui/src/**
apps/server/src/**
apps/desktop/src-tauri/src/**
packages/core/src/**
docs/configuration.md
README.md
```

Test procedure:

1. Confirm what docs claim.
2. Check CLI support.
3. Check TUI support.
4. Check server support.
5. Check whether desktop depends on server behavior.
6. Compare behavior and config names.
7. Report mismatches.

Prompt:

```text
Only audit cross-entry consistency for this capability:
<capability>

Output table:
Entry point | Reads config | Passes to core | Runtime behavior | Tests | Evidence | Result

Then list only mismatches:
- Mismatch:
- Evidence:
- User impact:
- Suggested test:
```

## 3. Permission And Security Audit

Files to inspect:

```text
packages/core/src/tools/**
packages/core/src/agent/loop.ts
packages/core/src/agent/rules.ts
packages/core/src/hooks/**
packages/core/tests/tools/**
packages/core/tests/agent/**
docs/configuration.md
```

Test procedure:

1. List every shell execution point.
2. List every file read/write/delete point.
3. List every network request point.
4. List every permission confirmation point.
5. For each point, identify model-controlled input.
6. Confirm raw command/path is shown in prompts.
7. Confirm tool results are treated as data, not instructions.
8. Confirm workspace boundaries and sandbox behavior.
9. Confirm tests cover deny/allow, path escape, and command classification.

Prompt:

```text
Only audit permissions and security.

For each execution/write/network/permission point, output:
- Operation:
- Code location:
- Model-controlled inputs:
- Permission level:
- Existing guard:
- Bypass risk:
- Existing tests:
- Missing tests:
- Severity: P0/P1/P2/P3
```

## 4. Agent Loop And Trace Audit

Files to inspect:

```text
packages/core/src/agent/loop.ts
packages/core/src/agent/context.ts
packages/core/src/agent/trace.ts
packages/core/tests/agent/**
packages/core/tests/hooks/**
packages/core/tests/subagents/**
```

Test procedure:

1. Trace how `messages` changes during a run.
2. Trace every call to `trace.message` and `trace.event`.
3. Check tool-call parsing and invalid JSON behavior.
4. Check failed tool-call handling.
5. Check repeated-failure detection.
6. Check provider switching for plan runs and escalation.
7. Check compaction behavior.
8. Check resume/replay assumptions.
9. Check max-turn and max-tool-call termination.
10. Compare behavior with tests.

Prompt:

```text
Only audit agent loop and trace behavior.

Output findings using:
- Behavior:
- Code path:
- Trace coverage: traced / not traced / uncertain
- Replay/resume risk:
- Trigger condition:
- Existing test:
- Missing test:
- Severity:
```

## 5. Desktop Release Audit

Files to inspect:

```text
apps/desktop/src-tauri/src/main.rs
apps/desktop/src-tauri/src/serve.rs
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src-tauri/README.md
apps/desktop/docs/RELEASING.md
.github/workflows/release-desktop.yml
apps/desktop/package.json
```

Test procedure:

1. Trace startup from Tauri `main`.
2. Check how the server command is resolved.
3. Check whether a DMG-only install can start without global CLI or source checkout.
4. Check workspace selection.
5. Check process cleanup on exit.
6. Check updater config, pubkey, artifact generation, and release docs.
7. Check signing/notarization assumptions.
8. Check tests for command resolution and URL parsing.

Prompt:

```text
Only audit the Tauri desktop release path.

Assume a user installed only the DMG and has no source checkout and no global seekforge CLI.

Output:
- Can the app start? yes / no / uncertain
- Startup chain:
- External dependencies:
- Failure point:
- User-facing error:
- Evidence:
- Missing release test:
```

## 6. Frontend UI State Audit

Files to inspect:

```text
apps/desktop/src/components/**
apps/desktop/src/views/**
apps/desktop/src/lib/i18n/**
apps/desktop/src/index.css
apps/desktop/src/types.ts
```

Test procedure:

1. Check every view for loading, empty, error, and long-data states.
2. Check buttons/cards for possible text overflow.
3. Check fixed widths and fixed column layouts.
4. Check behavior with long paths, long session names, and Chinese text.
5. Check layout with sidebar open and todos panel open.
6. Check light/dark theme assumptions.
7. Check whether API failures are visible and recoverable.

Prompt:

```text
Only audit frontend UI state and layout risks.

Output:
- Component/view:
- Missing state or layout risk:
- Triggering data/viewport:
- Evidence:
- Suggested manual or Playwright check:
- Severity:
```

## 7. Dependency And Release Package Audit

Files and command output to inspect:

```text
package.json
pnpm-lock.yaml
apps/*/package.json
packages/*/package.json
pnpm audit --audit-level moderate output
```

Test procedure:

1. List high and moderate audit findings.
2. Map each finding to package paths.
3. Decide whether it affects runtime, build, dev server, or publishing only.
4. Check package `files`, `bin`, `exports`, and build scripts.
5. Check whether npm package artifacts include required files.
6. Check whether release/build commands use vulnerable tooling in risky contexts.

Prompt:

```text
Only audit dependencies and package release risk.

Output:
- Package/advisory:
- Severity:
- Affected dependency path:
- Runtime/build/dev impact:
- Current version:
- Patched version:
- Evidence:
- Suggested verification after upgrade:
```

## 8. Documentation Consistency Audit

Files to inspect:

```text
README.md
docs/*.md
apps/*/README.md
apps/desktop/docs/RELEASING.md
apps/cli/src/index.ts
apps/cli/src/commands/**
apps/server/src/config.ts
apps/tui/src/config.ts
```

Test procedure:

1. Extract concrete claims from docs.
2. For each command claim, find the command implementation.
3. For each config claim, find config type, loader, setter, and runtime use.
4. For each release claim, find matching config/workflow.
5. For each default value claim, compare with source constants.
6. Report overclaims and stale examples.

Prompt:

```text
Only audit documentation consistency.

Output:
- Documentation claim:
- Documentation location:
- Implementation evidence:
- Status: consistent / inconsistent / uncertain
- User impact:
- Suggested doc or code fix:
```

## 9. Final Report Template

Merge section results into this format:

```text
## Findings

1. [P0/P1/P2/P3] Title
   - Area:
   - Evidence:
   - Trigger condition:
   - Impact:
   - Recommended fix:
   - Suggested test:

## Verification

- Commands run:
- Passing checks:
- Failing checks:
- Failures caused by environment:
- Not covered:

## Open Questions

- Needs human confirmation:
```

Severity scale:

- P0: permission bypass, data loss, core feature unusable, release package unusable.
- P1: major entry point broken, high security finding, documented config does not work.
- P2: doc/implementation mismatch, edge-case bug, missing regression test.
- P3: UX issue, maintainability risk, low-probability compatibility issue.

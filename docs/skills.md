# Skills

> **English** | [简体中文](skills.zh-CN.md)

Skills are bounded procedure briefs selected for the current task. They add
instructions to the system prompt; they never grant tool permissions, approve
commands, or weaken the sandbox.

## Layout and precedence

A native skill is a physical directory containing two regular files:

```text
.seekforge/skills/review-api/
├── skill.json
└── SKILL.md
```

`skill.json` uses `apiVersion: 1` and defines `id`, `name`, `description`,
`tags`, `triggers`, optional `negativeTriggers`, `taskTypes`,
`appliesTo.languages/frameworks/filePatterns`, `dependsOn`, `conflictsWith`,
`order`, `priority`, `enabled`, and `risk` (`low`, `medium`, or `high`). Its
`id` must equal the directory name.
`SKILL.md` contains the procedure; headings named Procedure, Workflow, Steps,
Instructions, 步骤, 流程, or 操作步骤 are extracted preferentially.

Layers resolve as builtin < enabled plugin roots < global
`~/.seekforge/skills` < project `.seekforge/skills`. A higher layer replaces a
same-id lower layer. An `enabled:false` marker can disable a builtin.

## Automatic selection

Selection is deterministic and bounded to three skills by default. A task gets
points for unique trigger and tag matches, inferred task type, detected
frameworks/languages, and matching workspace paths. If none matches, a bounded
local lexical and character-similarity retrieval pass can find relevant
descriptions/procedures. `negativeTriggers` veto automatic selection; priority
only breaks otherwise relevant matches.
Latin terms match word boundaries, while CJK and punctuation-rich terms use
substring matching. Workspace discovery ignores generated/vendor directories
and stops after 5,000 paths. The signal index is cached in-process and is reused
only while every scanned directory plus `package.json` retains the same physical
identity and modification stamp.

`dependsOn` skills consume the same selection budget and are injected first.
Missing, disabled, high-risk, or cyclic dependencies reject the dependent
bundle. `conflictsWith` is resolved by the higher-ranked candidate, then `order`
provides deterministic phase ordering.

High-risk skills are excluded from automatic selection. They remain available
only through an explicit caller opt-in or a direct skill invocation. Every
selected brief includes its scope and risk, shares the 2,500-character prompt
budget fairly with other selected skills, and is selected again for each
resumed Agent/Auto-Loop task. Plugin roots and configuration are snapshotted
once per assembly and reused across skills, agents, hooks, and MCP tools. App
factories also snapshot loaded skill contents, so editing the store mid-run
cannot change the current Agent's prompt.

## Lifecycle and diagnostics

```bash
seekforge skill create review-api
seekforge skill import ./external/SKILL.md [-g] [-f]
seekforge skill list
seekforge skill show review-api
seekforge skill stats
seekforge skill repair [--id review-api] [-g]
seekforge skill enable|disable|remove review-api
```

External Claude-style `SKILL.md` frontmatter is converted into the native two-file
layout and starts at medium risk. Mutations use a cross-process lease, refuse to
race an active project Agent, reject linked/non-physical roots and leaves, and
replace imports atomically. CLI `skill list`, TUI `/skills`, Desktop Skills, and
`GET /api/skills/diagnostics` surface malformed or unsafe installations instead
of silently hiding them. Legacy object metadata without `apiVersion` remains
loadable and is reported as repairable; `skill repair` adds version 1 atomically
without discarding unknown user fields. Unsupported versions and non-object
metadata are never guessed.

Selection telemetry is appended best-effort to
`.seekforge/skills-usage.jsonl`. It never follows links or blocks on special
files, bounds each reason, serializes concurrent writers, and rotates at 8 MiB.
Each selected skill also receives a terminal success/failure outcome with
bounded turn, tool-call, cost, and configured-verifier observations. A failed
configured verifier counts as an unsuccessful outcome. `skill stats`, TUI `/skills`, Desktop,
and `GET /api/skills/stats` expose the aggregate. Automatic weighting begins
only after three terminal samples, is confidence-shrunk, and is capped to
`[-0.75, 0.75]`; it influences ranking only and never permissions. Telemetry
failure never changes the Agent result. For controlled measurement, the eval
harness includes the `no-skills` A/B variant.

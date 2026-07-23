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

`skill.json` defines `id`, `name`, `description`, `tags`, `triggers`, optional
`appliesTo.languages/frameworks/filePatterns`, `priority`, `enabled`, and
`risk` (`low`, `medium`, or `high`). Its `id` must equal the directory name.
`SKILL.md` contains the procedure; headings named Procedure, Workflow, Steps,
Instructions, 步骤, 流程, or 操作步骤 are extracted preferentially.

Layers resolve as builtin < enabled plugin roots < global
`~/.seekforge/skills` < project `.seekforge/skills`. A higher layer replaces a
same-id lower layer. An `enabled:false` marker can disable a builtin.

## Automatic selection

Selection is deterministic and bounded to three skills by default. A task gets
points for unique trigger and tag matches, detected frameworks/languages, and
matching workspace paths; priority only breaks otherwise relevant matches.
Latin terms match word boundaries, while CJK and punctuation-rich terms use
substring matching. Workspace discovery ignores generated/vendor directories
and stops after 5,000 paths.

High-risk skills are excluded from automatic selection. They remain available
only through an explicit caller opt-in or a direct skill invocation. Every
selected brief includes its scope and risk, shares the 2,500-character prompt
budget fairly with other selected skills, and is selected again for each
resumed Agent/Auto-Loop task. Plugin roots and configuration are snapshotted
once per assembly and reused across skills, agents, hooks, and MCP tools.

## Lifecycle and diagnostics

```bash
seekforge skill create review-api
seekforge skill import ./external/SKILL.md [-g] [-f]
seekforge skill list
seekforge skill show review-api
seekforge skill enable|disable|remove review-api
```

External Claude-style `SKILL.md` frontmatter is converted into the native two-file
layout and starts at medium risk. Mutations use a cross-process lease, refuse to
race an active project Agent, reject linked/non-physical roots and leaves, and
replace imports atomically. CLI `skill list`, TUI `/skills`, Desktop Skills, and
`GET /api/skills/diagnostics` surface malformed or unsafe installations instead
of silently hiding them.

Selection telemetry is appended best-effort to
`.seekforge/skills-usage.jsonl`. It never follows links or blocks on special
files, bounds each reason, serializes concurrent writers, and rotates at 8 MiB.
Telemetry failure never changes the Agent result.

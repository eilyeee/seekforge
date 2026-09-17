# Skills

> **English** | [简体中文](skills.zh-CN.md)

Skills are bounded procedures the agent follows for a kind of task. They reach
the model two ways: a few are selected automatically and pre-loaded as a brief,
and every model-invocable skill is listed so the model can load it with
`invoke_skill`. A skill never weakens the sandbox; what it may do to tool
permissions while it is active depends on who wrote it (see
[Tool rules while a skill is active](#tool-rules-while-a-skill-is-active)).

`GET /api/skills/supply-chain` and the Desktop Skills page expose a canonical
SHA-256 digest, API version, scope, risk, dependencies, conflicts, and loader
diagnostics for every active skill, including plugin-contributed skills.

## Layout and precedence

A skill is a physical directory named after its id, holding a `SKILL.md` and,
optionally, a `skill.json`:

```text
.seekforge/skills/review-api/
├── skill.json      (optional)
└── SKILL.md
```

`SKILL.md` contains the procedure, optionally opened by YAML frontmatter (see
[Claude Code skills](#claude-code-skills)). Headings named Procedure, Workflow,
Steps, Instructions, 步骤, 流程, or 操作步骤 are extracted preferentially for
the brief.

`skill.json` uses `apiVersion: 1` and may define `name`, `description`,
`tags`, `triggers`, `negativeTriggers`, `taskTypes`,
`appliesTo.languages/frameworks/filePatterns`, `dependsOn`, `conflictsWith`,
`order`, `priority`, `enabled`, `risk` (`low`, `medium`, or `high`), and the
invocation fields in their camelCase spelling (`whenToUse`, `argumentHint`,
`argumentNames`, `allowedTools`, `disallowedTools`, `model`, `effort`,
`context`, `agent`, `disableModelInvocation`, `userInvocable`, `paths`). Its
`id` must equal the directory name. When both files are present, `skill.json`
wins for every field it sets to a non-empty value; empty strings and lists
(what `skill create` scaffolds) let the frontmatter fill them in.

Any other file in the directory travels with the skill — a checklist, a
template, a script — and is readable with `read_skill`.

Layers resolve as builtin < enabled plugin roots < user
(`~/.claude/skills` when `claudeUserSkills` is on, then `~/.seekforge/skills`)
< project (`.claude/skills`, then `.seekforge/skills`). A higher layer replaces
a same-id lower layer, and inside one layer the `.seekforge` directory wins. An
`enabled:false` marker in a `.seekforge/skills` store disables a lower-layer
skill of the same id — a builtin, a plugin skill, or one read from
`.claude/skills`, none of which SeekForge ever edits.

## Claude Code skills

A Claude Code skill can be dropped in unchanged: `.claude/skills/<name>/SKILL.md`
in the project is always read, and `~/.claude/skills` is read once the user sets
`"claudeUserSkills": true` in their own config (the key is ignored in a
repository config). `SKILL.md` frontmatter supplies:

| Field | Meaning |
|---|---|
| `name`, `description` | Display name (default: the directory name) and summary (default: the first paragraph). |
| `when_to_use` | Shown beside the description in the listing. |
| `argument-hint`, `arguments` | Placeholder text, and the names bound to `$name` (a list or a space-separated string). |
| `allowed-tools`, `disallowed-tools` | Tool rules applied while the skill is active (below). |
| `model`, `effort` | Model for the rest of the run where the host can switch; `effort` is recorded but not applied mid-run. |
| `context: fork`, `agent` | Run the skill in a subagent; `agent` names it (`Explore`/`Plan` map to `explorer`/`planner`). |
| `disable-model-invocation` | `true`: only a user may invoke it — it is neither listed nor auto-selected. |
| `user-invocable` | `false`: hidden from slash menus (exposed as `userInvocable` on `GET /api/skills`). |
| `paths` | Globs; the skill is offered only when a workspace file matches one. |
| `triggers`, `tags` | SeekForge's own selection metadata, when present. |

Lists may be written as YAML lists, `[a, b]`, or comma/space separated
strings. A value SeekForge cannot read (`context: forked`,
`disable-model-invocation: maybe`, an unparsable tool entry) makes the skill a
diagnostic instead of being guessed at. Other Claude Code keys (`hooks`,
`shell`, `license`, …) are ignored. Frontmatter skills start at medium risk.

## Model invocation

The system prompt lists every enabled skill the model may load — id,
description and `when_to_use` (at most 1,536 characters each), the argument
hint, and whether it runs in a subagent — within an 8,000-character budget
that shortens every entry before dropping any and counts what it drops.
Disabled, high-risk, `disable-model-invocation`, and path-gated skills with no
matching file are left out. Skills already pre-loaded as a brief stay listed
and are marked, because the brief is only an excerpt.

`invoke_skill(name, arguments?)` returns the skill's instructions as the tool
result. Arguments are substituted the way Claude Code does it, in one pass so a
value is never expanded twice: `$ARGUMENTS` (the whole string),
`$ARGUMENTS[N]` and `$N` (0-based, shell-like tokens), and `$name` for each
entry of `arguments`; a placeholder without a value stays literal, and a body
with no placeholder gets `ARGUMENTS: …` appended. `${CLAUDE_SKILL_DIR}`,
`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_SESSION_ID}`
resolve to this run's values. `` !`command` `` blocks are never run — the
model triggers this call, and it must not be able to run a shell through it.

Loading the same skill with the same arguments twice in a run returns a short
"already loaded" note; `reload: true` returns the instructions again (for
example after compaction dropped them).

## Tool rules while a skill is active

An inline skill's rules apply from its invocation to the end of the run, on
that run's policy only (subagents it dispatches afterwards inherit them); the
next run starts clean. Entries use Claude Code's
syntax with its tool names (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`,
`WebFetch`, …, mapped to SeekForge's tools) or SeekForge's own names:

- `disallowed-tools` adds deny rules at **every** scope. An entry SeekForge
  cannot express exactly (`Bash(npm test)`, `Read(*.ts)`) denies the whole
  tool instead — a deny that matches too much fails closed — and a path entry
  also denies its absolute spelling under the workspace.
- `allowed-tools` adds allow rules — **only** for builtin skills and user-scope
  skills (`~/.seekforge/skills`, `~/.claude/skills`, and skills of a plugin the
  user enabled). A project skill is repository content; its `allowed-tools` is
  ignored and the invocation result says so. `Bash(git log:*)` becomes an allow
  rule for the `git log` prefix; an entry that cannot be expressed exactly is
  not pre-approved at all, so the user is asked as usual.

Allow rules go through the ordinary matcher, so deny rules, ask rules,
`dangerous` commands and compound shell commands keep their precedence. See
[Security Model](security-model.md#skill-tool-rules).

## Forked skills

`context: fork` runs the skill in a subagent through the normal dispatch
machinery and returns its report. The agent is the one `agent` names (copied
under the id `skill:<id>`, so `agent_send` cannot later resume it without the
skill's rules) or, without `agent`, an ad-hoc agent in the parent's mode. The
fork runs with the run's rules plus the skill's, and `model` becomes the
subagent's model. A fork that may edit is classified as a write: in `confirm`
mode the user approves `invoke_skill` itself, and a read-only parent cannot
fork an editing agent. Hosts without subagents run the skill inline and say so.

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

## Two levels: the brief, then the rest

What reaches the prompt is an excerpt. Each selected skill gets a share of the
2,500-character budget, and a procedure longer than its share is cut — with a
marker naming the tool that returns the rest:

```text
…[truncated — call read_skill("review-api") for the full procedure]
```

`read_skill(id)` returns the complete `SKILL.md` plus a list of the files the
skill ships; `read_skill(id, file)` returns one of those files. Both are
read-only. This is the point of the two levels: the brief is cheap enough to
inject on every session and says what a skill is *for*, and the model pays for
the full text only when it decides the skill applies.

Bundled files are resolved inside the skill's own directory, with symlinks and
`..` rejected — a skill can come from the repository, so its file names are as
untrusted as any other repository content.

A skill that does not fit the remaining budget is left out of the brief
entirely rather than included as a fragment: an absent skill is something the
model can reason about, a mutilated one is not.

The 2,500-character budget is shared **by need, not evenly**. An even split
starved a long procedure while a short one left its share unspent — with three
builtins selected the even share is 832 characters, and `simplify` needs only
740 of it while `bugfix` needs 1,104 — one brief leaving 92 characters unspent
and truncating another skill by 272 at the same time. Allocation now water-fills: each skill receives only what it
can spend, and the remainder is re-offered to the ones still short. What is left
after that is handed to a single skill rather than spread thin, because a whole
extra step delivered beats a few characters shared three ways.

A truncated procedure is cut at a **step boundary**, never mid-step. These are
numbered lists whose steps wrap across lines, so a line-boundary cut still landed
inside step 4 — and half of step 4 reads exactly like all of step 4, which the
model has no way to detect. The partial step is dropped and the
`read_skill(…)` marker says where the rest is.

High-risk skills are excluded from automatic selection. They remain available
only through an explicit caller opt-in or a direct skill invocation. Skills with
`disable-model-invocation` are never selected, and a `paths` gate must match a
workspace file. Every
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

`skill import` copies an external Claude-style `SKILL.md` verbatim (so its
invocation fields keep working) and writes a `skill.json` with the selection
metadata it derives; the skill starts at medium risk, and frontmatter SeekForge
cannot read is refused before anything is written. `skill show` prints the
invocation fields and where the skill came from. `skill enable|disable` also
works on a `SKILL.md`-only skill (the flag goes into a minimal `skill.json`)
and, through a marker, on skills read from `.claude/skills` or a plugin.
Mutations use a cross-process lease, refuse to
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

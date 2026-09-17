# Hooks

> **English** | [简体中文](hooks.zh-CN.md)

Hooks are programs you configure to run at fixed points of an agent run:
before and after every tool call, when a permission prompt is about to appear,
when a session starts or ends, around context compaction, and when the agent
is about to finish. A hook can observe, add context for the model, refuse an
action, answer a permission prompt, or keep the agent working.

Hooks are **user-owned**. They come from `~/.seekforge/config.json`, an explicit
`--settings` file, or an enabled [plugin](plugins.md); a repository's
`.seekforge/config.json` cannot add or change them. The Desktop hook editor
writes the user config.

## Configuring a hook

```json
{
  "hooks": {
    "preToolUse": [
      { "match": "run_command", "pattern": "npm publish", "command": "echo 'no publishing' >&2; exit 1" },
      { "match": "write_file|apply_patch", "type": "http", "url": "http://127.0.0.1:8787/review", "timeout": 5 }
    ],
    "stop": [
      { "type": "prompt", "prompt": "Did the agent run the tests after its last edit? $ARGUMENTS" }
    ],
    "sessionEnd": [{ "command": "notify-send 'SeekForge session ended'" }]
  }
}
```

Every stage holds a list of entries; they run one after another in that order.
An entry has these fields:

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | all | `"command"` (default), `"http"` or `"prompt"`. |
| `match` | all | Which calls the hook is for (see [Matchers](#matchers)). Absent, `""` or `"*"` = all. |
| `pattern` | all | Prefix of the call's raw command (shell tools) or path (file tools), matched on a word / path boundary. Absent = any. |
| `timeout` | all | Seconds before the hook is abandoned, `0 < timeout ≤ 600`. Default 10 (30 for `prompt`). A timed-out hook counts as failed. |
| `command` | command | Shell command, run with `/bin/sh -c` (Windows: `cmd /d /s /c`) in the workspace. |
| `url` | http | `http://` or `https://` URL the payload is POSTed to. No credentials in the URL. |
| `headers` | http | Extra request headers. `${NAME}` expands the environment variable `NAME` — only if it is listed in `allowedEnvVars`; any other reference expands to an empty string and is reported. |
| `allowedEnvVars` | http | Environment variables `headers` may read. |
| `prompt` | prompt | The condition a model checks. `$ARGUMENTS` marks where the event goes; without it, the event is appended. |
| `model` | prompt | Model to check with, when the surface can route to it; otherwise the run's model. |

An entry that fails validation — unknown `type`, missing `command`/`url`/`prompt`,
a non-http URL, an out-of-range `timeout`, an unsafe `match` — is dropped when
the config loads and never runs.

### Matchers

`match` is tested against the tool name on the tool stages (`preToolUse`,
`permissionRequest`, `postToolUse`, `postToolUseFailure`) and against the
subagent id on `subagentStart` / `subagentStop`. The other stages ignore it.

- Letters, digits, `_`, `-` separated by `|` or `,` are a list of exact names:
  `write_file|apply_patch`.
- Anything else is a regular expression matched against the **whole** name:
  `mcp__github__.*` matches every tool of that server, and `apply.*` does not
  match `reapply_patch`.

A regular expression is refused when it could backtrack pathologically: a
repeated group that itself repeats or alternates (`(a+)+`, `(a|b)*`), a
backreference, more than four repeating quantifiers, or more than 256
characters.

## Hook types

Every type receives the same JSON event — `{ "stage": …, "sessionId": …,
"workspace": …, …stage fields }` — and answers with the same
[output protocol](#output-protocol). Tool arguments, commands, paths and tool
output reach a hook only inside that JSON, never on a command line, in a URL, or
in a header.

### `command`

The event arrives on stdin. Secret-looking environment variables are removed
from the hook's environment, and these are added:

| Variable | Value |
| --- | --- |
| `SEEKFORGE_HOOK_STAGE` | The stage that fired. |
| `SEEKFORGE_TOOL` | The tool name on tool stages, otherwise empty. |
| `SEEKFORGE_PROJECT_DIR` | The workspace the session runs in (also the hook's working directory). |

Exit code 0 is success; stdout is the hook's output. Any other exit code is a
failure, and the tail of stdout+stderr is its reason. The whole process group
is killed on timeout or cancellation.

### `http`

The event is the POST body (`Content-Type: application/json`). A `2xx`
response's body is the hook's output. Any other status is a failure, and so is
a redirect: redirects are never followed, because they could carry your headers
to another host — configure the final URL. Network errors and timeouts are
failures too.

### `prompt`

The event is shown to a model, fenced as data, with an instruction to answer
`{"ok": true}` or `{"ok": false, "reason": "…"}`.

- `{"ok": false}` is read as `{"decision": "block", "reason": …}` — on
  `preToolUse` that refuses the call, on `stop` it keeps the agent working, on
  `postToolUse` the reason reaches the model.
- `{"ok": true}` is **no decision**. A model check can refuse an action; it can
  never approve one past a permission prompt. The event contains text the agent
  and its tools produced, so treat a prompt hook as a reviewer, not a security
  boundary — enforce policy with a command hook.
- A reply without a verdict is a failure.
- The check runs on the session's provider (or `model`, when routable) and its
  tokens count toward the session's usage and cost — except on `sessionEnd`,
  which runs after the session's totals are final. Surfaces with no model to
  ask — `seekforge mcp-serve`, and mechanical `/compact` in the TUI, REPL and
  server — cannot evaluate prompt hooks: there they fail.

## Stages

| Stage | Fires | A failing hook blocks? | Stage fields |
| --- | --- | --- | --- |
| `preToolUse` | before every tool call, after the policy's absolute refusals and before any permission prompt | **yes** | `toolName`, `args`, `command`?, `path`? |
| `permissionRequest` | a tool call (or a subagent dispatch) is about to prompt the user | no — the prompt is shown | tool fields + `permission`, `description` |
| `postToolUse` | after every tool call that ran | no | tool fields + `result` |
| `postToolUseFailure` | after `postToolUse`, when the tool returned an error | no | tool fields + `result` |
| `sessionStart` | a top-level run starts (also on resume) | no | `task`, `mode`, `resuming` |
| `userPromptSubmit` | right after `sessionStart`, for the task | **yes** | `task` |
| `preCompact` | before compaction rewrites the conversation | no | `reason` (`"auto"` / `"manual"`), `focus`? |
| `postCompact` | after compaction | no | `reason`, `droppedTurns`, `beforeTokens`?, `afterTokens`? |
| `stop` | the top-level agent is about to give its final answer | no | `summary`, `stopHookActive` |
| `subagentStart` | a dispatched subagent run is about to start | no | `agentId`, `task` |
| `subagentStop` | a dispatched subagent run finished | no | `agentId`, `ok` |
| `notification` | a permission prompt or an `ask_user` question is shown | no | `kind`, `detail` |
| `sessionEnd` | a top-level session ended, whatever its status | no | `status` |

A hook **fails** when it exits non-zero, gets a non-`2xx` response, times out,
cannot be evaluated, or returns no verdict. On the two blocking stages the
first failure refuses the call / fails the run with the hook's output as the
reason, and later hooks of that stage do not run. Everywhere else a failure is
logged to stderr and the run carries on.

`sessionStart`, `userPromptSubmit`, `stop` and `sessionEnd` fire only for the
top-level run; subagent runs do not fire them.

`postToolUse` and `postToolUseFailure` receive the tool's `result`:
`{ "ok", "errorCode", "response", "responseTruncated"? }`. `response` is the
tool's data (or its error) with every string passed through the same secret
redaction command output gets; beyond 16,000 characters it becomes a head/tail
string preview and `responseTruncated` is `true`.

## Output protocol

A hook that succeeds may print (or respond with) a JSON object. Anything that is
not a JSON object is ignored — except on `userPromptSubmit`, where plain text is
context for the model. Fields may sit at the top level; the stage-specific ones
are also read under `hookSpecificOutput`.

| Field | Stages | Effect |
| --- | --- | --- |
| `systemMessage` | all | Shown to the user as a notice. |
| `continue: false` | see below | Stop what the stage guards. |
| `stopReason` | with `continue: false` | Shown to the user. |
| `suppressOutput: true` | all | Keep this hook's output out of the transcript (the model still gets its context). |
| `additionalContext` | `sessionStart`, `userPromptSubmit`, `subagentStart`, `postToolUse`, `postToolUseFailure` | Text for the model (see below). |
| `permissionDecision` + `permissionDecisionReason`, or `decision` + `reason` | `preToolUse` | `allow`, `deny` (also `block`), or `ask`. |
| `updatedInput` | `preToolUse` | Replacement tool arguments. |
| `decision.behavior` + `decision.message` (under `hookSpecificOutput`), or `decision` + `reason` | `permissionRequest` | `allow` or `deny`. |
| `decision: "block"` + `reason` | `userPromptSubmit`, `preCompact`, `stop`, `postToolUse`, `postToolUseFailure` | See each stage. |

What `continue: false` stops:

| Stage | Effect |
| --- | --- |
| `preToolUse` | The call is refused and the run ends after this turn's results are recorded. |
| `postToolUse`, `postToolUseFailure` | The run ends after this turn's results are recorded; the turn's remaining calls do not run. |
| `permissionRequest` | The prompt is answered "deny"; for a tool call, the run also ends after this turn. |
| `userPromptSubmit` | The run is refused. |
| `preCompact` | A manual compaction is cancelled. |
| `stop` | The agent finishes even if another stop hook asked it to continue. |
| others | Nothing; `stopReason` is still shown. |

A run ended by a hook fails with the code `stopped_by_hook` and the
`stopReason` as its message.

### `preToolUse` and the permission prompt

A tool call goes through these steps:

1. **Absolute refusals** — the run's `allowedTools`, deny rules, ask (read-only)
   mode, and the dangerous-command denylist. A call refused here runs no hook.
2. **`preToolUse`** — every matching hook runs. The first failure or `deny`
   refuses the call without asking anyone.
3. **`updatedInput`** — replacement arguments are validated against the tool's
   schema (an invalid one fails the call with `invalid_hook_args`), classified
   again and put through step 1 again, so a rewrite cannot reach a refused
   command or path.
4. **Permission** — the policy decides as usual, with the hooks' answer:
   - `ask` from any hook forces a prompt for this call, even one the policy
     would approve on its own; the answer covers only this call.
   - otherwise `allow` from any hook answers the prompt the policy would have
     shown — for `write`, `execute` and `env` calls alike, as an allow rule
     can. It does **not** answer a prompt an `ask` rule requires, and it does
     not cover a shell command with control syntax (`&&`, `|`, `;`, …), the
     same limit allow rules have.
5. **`permissionRequest`** — where a prompt would appear, these hooks run
   first. A `deny` refuses the call (`hook_blocked`); an `allow` answers the
   prompt — except one an `ask` rule or a `preToolUse` `ask` requires, which
   still goes to you. With no decision, you are asked (and `notification`
   fires).
6. The tool runs, then **`postToolUse`** and, if it failed,
   **`postToolUseFailure`**.

The session's tool-call log records `hook_allowed` or `hook_denied` when a hook
answered in your place.

### Context for the model

- `sessionStart` and `userPromptSubmit` context is appended to the task as
  `<hook-context>` blocks (each stage capped at 8,000 characters, with `<`, `>`
  and `&` escaped so the text cannot close its block). `sessionStart` and
  `subagentStart` contribute only an explicit `additionalContext`, never plain
  stdout, so a hook that merely logs stays out of the prompt.
- `subagentStart` context is appended to the subagent's task.
- `postToolUse` / `postToolUseFailure` `additionalContext`, and the `reason` of
  a `decision: "block"`, are appended beside the tool result the model reads,
  under a line that labels them as the user's hook output, not the tool's
  (capped at 4,000 characters per call). They are also shown to you as notices
  unless the hook set `suppressOutput`. The tool call itself is not changed.

### `stop`

A `stop` hook runs when the top-level agent is about to give its final answer
(after the built-in finalize checks). `decision: "block"` with a `reason` keeps
the run going: the model is told the reason and continues. The event's
`stopHookActive` is `true` once a stop hook has already done that in this run,
so a hook can let the agent finish on the second try. Independently, stop hooks
can keep one run going at most 5 times, and never past the run's turn limit.

### Compaction

Automatic compaction fires `preCompact` (`reason: "auto"`) and `postCompact`;
it cannot be blocked, because the next request would not fit the context
window without it. Manual compaction fires them with `reason: "manual"` when
the surface passes your hooks to it (`compactSessionNow` /
`llmCompactSessionNow`); there a `decision: "block"` or `continue: false` from
`preCompact` cancels the compaction and leaves the session untouched. Hooks do
not fire for a session too short to compact.

## Plugins

A plugin's `contributes.hooks` uses the same entries and stages, and runs only
after you enable the plugin's reviewed digest. A plugin's `http` hook may not
list `allowedEnvVars`: command hooks never see your secrets, and a plugin
cannot get them back through a header. `seekforge mcp-serve` does not load
plugin hooks.

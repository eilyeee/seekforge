# Configuration

SeekForge reads configuration from two JSON files and supports overriding via
environment variables, CLI flags, and a `--settings` file. All config keys are
optional — the tool works out of the box with just an API key.

## File locations

| Location | Path | Created by |
| --- | --- | --- |
| **Global** | `~/.seekforge/config.json` | `seekforge config set <key> <value> --global` |
| **Project** | `<project>/.seekforge/config.json` | `seekforge config set <key> <value>` (no flag) |

Both are plain JSON. `seekforge config set` writes with `0o600` permissions
(user-read-only) regardless of whether `--global` is used. Project config lives
alongside the session traces, memory, and skills that SeekForge manages under
`.seekforge/`.

---

## Config keys

All keys belong to the `CliConfig` type (`apps/cli/src/config.ts`).

### `apiKey`

DeepSeek API key. Prefer the `DEEPSEEK_API_KEY` environment variable so the key
never touches disk — but `config set` accepts it for convenience.

```json
{ "apiKey": "sk-..." }
```

Settable via `config set`? **Yes**.
When displayed by `config show`, the value is masked to the first 6 characters.

### `model`

The DeepSeek model to use. Defaults to `deepseek-v4-flash`.

```json
{ "model": "deepseek-v4-pro" }
```

Settable via `config set`? **Yes**.
Also overridable per run with `--model` / `-m`.

### `baseUrl`

Custom API base URL for DeepSeek-compatible proxies or self-hosted endpoints.

```json
{ "baseUrl": "https://api.deepseek.com/v1" }
```

Settable via `config set`? **Yes**.

### `runtimeBin`

Path to the `seekforge-runtime` binary (Rust execution backend). When set, file
I/O, command execution, and git operations are delegated to a trusted Rust
binary for defense-in-depth containment re-checks. Permission decisions stay in
TypeScript.

```json
{ "runtimeBin": "/usr/local/bin/seekforge-runtime" }
```

Also read from the `SEEKFORGE_RUNTIME_BIN` environment variable (highest
precedence).

Settable via `config set`? **Yes**.

### `commandAllowlist`

Array of command prefixes that are allowed to auto-run without confirmation
(beyond the built-in safe commands). A common use is allowing `pnpm test` or
`cargo build` so the agent runs them without prompting.

```json
{ "commandAllowlist": ["pnpm test", "cargo build", "npm run"] }
```

When setting via `seekforge config set`, pass a comma-separated string:

```bash
seekforge config set commandAllowlist "pnpm test, cargo build"
```

Settable via `config set`? **Yes** (as comma-separated string).

### `models`

The selectable model list offered by the desktop/server model picker (and the
TUI `/model` argument completion). A plain array of model IDs; the first entry is
treated as the default suggestion. The CLI itself accepts any model string via
`--model` / `/model`, so this key mainly shapes the picker UI — but it is shared
config, so setting it once applies everywhere.

```json
{ "models": ["deepseek-v4-flash", "deepseek-v4-pro"] }
```

When unset, the server falls back to a built-in default model list.

Settable via `config set`? **Yes** (as comma-separated string).

### `sandbox`

OS-level command sandboxing. When unset, sandboxing is off.

| Value | Behaviour |
| --- | --- |
| `"off"` (or absent) | No sandboxing; commands run as the current user. |
| `"workspace-write"` | Commands run inside a sandbox that allows writes to the workspace directory. Network is accessible. Uses `seatbelt` (macOS) or `bwrap` (Linux). |
| `"restricted"` | Like `workspace-write` but network access is blocked. |

If the requested sandbox mechanism is unavailable at runtime, the session fails
hard — it never silently falls back to unsandboxed execution. A
denial-looking sandbox failure prompts once before retrying unsandboxed.

```json
{ "sandbox": "workspace-write" }
```

Settable via `config set`? **Yes** — validated against `off` / `workspace-write`
/ `restricted`.

### `compaction`

Context compaction strategy that keeps long sessions inside the model window.
Micro-compaction clears old tool outputs first; then the middle of the
conversation is folded into a digest.

| Value | Behaviour |
| --- | --- |
| `"mechanical"` (default) | Digest is generated with a fixed prompt — fast and deterministic. |
| `"llm"` | Digest is summarized by the model itself (falls back to mechanical on failure). More accurate but costs a model call. |

The prompt prefix is kept stable to hit DeepSeek context caching (cache-hit
input is ~10× cheaper).

```json
{ "compaction": "llm" }
```

Settable via `config set`? **Yes** — validated against `mechanical` / `llm`.

### `thinking`

Controls DeepSeek V4 thinking mode. When `true`, the model shows its reasoning
in a collapsible thought block (never echoed back into requests). When `false`
or absent, the API default applies.

In the REPL, `/think on|off|high|max` toggles this at runtime.

```json
{ "thinking": true }
```

Settable via `config set`? **Yes** — accepts `true` / `false`.

### `reasoningEffort`

V4 reasoning effort level. Only meaningful when thinking is enabled.

| Value | Behaviour |
| --- | --- |
| `"high"` | Standard reasoning depth. |
| `"max"` | Maximum reasoning depth — more thorough but slower and more expensive. |

```json
{ "reasoningEffort": "max" }
```

Settable via `config set`? **Yes** — validated against `high` / `max`.

### `planModel`

Stronger model used for plan runs (`/plan` / `--plan`) and failure escalation,
resolved on the same key/endpoint as `model` (e.g. plan/escalate on a `pro`
model while edits run on a `flash` one).

```json
{ "model": "deepseek-v4-flash", "planModel": "deepseek-v4-pro" }
```

`planModel` **must support tool/function calling** — do not set it to
`deepseek-reasoner` (no function calling). The agent falls back to the default
model for it rather than break the tool loop.

Settable via `config set`? **No** — edit the file directly.

### `escalateOnFailure`

**Default off.** Once the model loops on an identical failed tool call, hand the
rest of the run to `planModel` (requires `planModel` set) — a stronger model
takes over only when the default is clearly stuck, so it never adds overhead to
runs that are going fine.

```json
{ "planModel": "deepseek-v4-pro", "escalateOnFailure": true }
```

A related **always-on** safeguard needs no config: if a tool call fails again
with identical arguments, the harness injects a one-time reflection nudge telling
the model to stop looping and re-read.

> Note: two other experimental levers (`autoReview`, `planFirst`) were prototyped
> and **removed** — an eval A/B (`control` vs them) showed they regressed quality
> and raised cost on every edit without converting any failures to passes. See
> CHANGELOG round 36.

Settable via `config set`? **No** — edit the file directly.

### `memoryAutoApproveConfidence`

**Default off.** When set to a number in `0..1`, auto-extracted memory facts whose model confidence is `>= ` the threshold are written directly to `project.md` as approved (instead of being queued as pending candidates for review); facts below the threshold still wait for `seekforge memory approve`. Inspect extraction quality first with `seekforge memory stats`. Edit the file directly; not settable via `config set`.

### `permissionRules`

Fine-grained allow/deny permission rules that augment the built-in 5-level
permission policy. Each rule is an object:

```typescript
type PermissionRule = {
  action: "allow" | "deny";
  /** Tool name or "*" for any tool. */
  tool: string;
  /**
   * Prefix matched against the classified command (run_command family)
   * or path (fs tools). Absent = matches any call of that tool.
   */
  match?: string;
};
```

**Evaluation order**: First matching rule of each action category wins. Deny
rules are scanned before allow rules, so a matching deny always blocks (even
readonly tools). Allow rules never override ask-mode blocking and never rescue
`"dangerous"`-classified calls.

Rules from different config layers are concatenated rather than replaced:
**settings > project > global**. Because first match wins, settings-layer rules
take highest precedence among file layers.

```json
{
  "permissionRules": [
    { "action": "deny", "tool": "run_command", "match": "rm -rf /" },
    { "action": "allow", "tool": "run_command", "match": "pnpm build" }
  ]
}
```

Settable via `config set`? **No** — edit the file directly.

### `mcpServers`

MCP (Model Context Protocol) servers — Claude Code-compatible. Each entry maps
a server name to its configuration. Two transport modes are supported:

```typescript
type McpServerConfig = {
  /** Executable for stdio transport (e.g. "npx"). */
  command?: string;
  args?: string[];
  /** Extra env vars merged over process.env (stdio only). */
  env?: Record<string, string>;
  /** Streamable HTTP URL. Presence selects HTTP; command/args/env ignored. */
  url?: string;
  /** Extra HTTP headers sent on every request (HTTP only). */
  headers?: Record<string, string>;
  /** SeekForge-specific: trusted servers' tools run at "write" level (default false). */
  trusted?: boolean;
};
```

Exactly one transport applies per server: if `url` is present, HTTP transport
is used; otherwise `command` defines a stdio subprocess.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "playwright": {
      "url": "https://mcp.example.com/playwright",
      "headers": { "Authorization": "Bearer <token>" },
      "trusted": true
    }
  }
}
```

Servers are merged per name across config layers (later wins):
**settings > project > global**.

Settable via `config set`? **No** — use `seekforge mcp add/list/remove` or
edit the file directly.

### `hooks`

User-defined shell hooks that fire at various stages of the agent lifecycle.
Hooks receive a JSON payload on stdin with the stage name and relevant context
(`sessionId`, `workspace`, `toolName`, `args`, `command`, `path`, etc.).

```typescript
type HookConfig = {
  /** Fires before every tool call. Non-zero exit *blocks* the tool with a reason. */
  preToolUse?: HookEntry[];
  /** Fires after every tool call (receives `{ ok, errorCode }` — never raw output). */
  postToolUse?: HookEntry[];
  /** Fires when a session starts. */
  sessionStart?: HookEntry[];
  /** Fires when the user submits a prompt. stdout is injected into the task as context. */
  userPromptSubmit?: HookEntry[];
  /** Fires before context compaction. */
  preCompact?: HookEntry[];
  /** Fires when the agent receives a stop signal (Ctrl+C). */
  stop?: HookEntry[];
  /** Fires when a subagent stops. */
  subagentStop?: HookEntry[];
  /** Fires for non-blocking notifications. */
  notification?: HookEntry[];
  /** Fires when the session ends. Receives final session status. */
  sessionEnd?: HookEntry[];
};

type HookEntry = {
  /** Tool name this hook applies to, or "*" for any (default "*"). */
  match?: string;
  /** Prefix matched against the classified command or path. Absent = any. */
  pattern?: string;
  /** Shell command, run via `/bin/sh -c` with cwd = workspace. */
  command: string;
};
```

**Blocking stages**: `preToolUse` and `userPromptSubmit` — a non-zero exit
prevents the tool call or run from proceeding. All other stages are advisory
(logging, notifications, telemetry).

```json
{
  "hooks": {
    "preToolUse": [
      {
        "match": "run_command",
        "pattern": "npm publish",
        "command": "echo 'blocking npm publish' && exit 1"
      }
    ],
    "sessionEnd": [
      {
        "command": "echo 'session $SESSION_ID ended' >> /tmp/seekforge.log"
      }
    ]
  }
}
```

Hook entries are concatenated per stage across config layers for **all** stages
(`loadConfig` merges every stage the agent supports): **global → project →
settings**. The settings-layer hooks run last, and a hook defined in a lower
layer is never silently dropped when a higher layer also defines hooks for a
different stage.

Settable via `config set`? **No** — edit the file directly.

#### preToolUse JSON stdout protocol

A `preToolUse` hook that exits 0 may print a JSON object on stdout to control
the call (anything that isn't a JSON object is ignored and the plain exit-code
behavior applies). Both the legacy shape and the Claude-Code shape are accepted:

| Field | Where | Effect |
| --- | --- | --- |
| `decision` | top-level (`"allow"` / `"deny"`) | `deny` blocks the call (`reason` becomes the block reason). `allow` explicitly allows it and **skips the remaining `preToolUse` hooks**. |
| `hookSpecificOutput.permissionDecision` | nested (`"allow"` / `"deny"` / `"ask"`) | Same as `decision`, plus `"ask"` — explicitly defer to the normal permission flow and keep running later hooks. Also read at the top level as `permissionDecision`. |
| `permissionDecisionReason` / `reason` | nested / top-level | The human-readable reason shown when denying. |
| `updatedInput` | top-level or under `hookSpecificOutput` | Replacement tool arguments. The dispatcher applies them before the tool runs, **re-validating against the tool schema and re-running permission checks** on the new args. `preToolUse` only. |
| `continue` | top-level (boolean) | `false` blocks the call (treated like a deny), using `systemMessage` as the reason. Parsed on all stages but only blocks on `preToolUse` and `userPromptSubmit`. |
| `systemMessage` | top-level (string) | Shown to the user as a notice; also the block reason when `continue: false` blocks. Parsed on all stages. |
| `additionalContext` / `hookSpecificOutput.additionalContext` | top-level / nested (string) | Injected into the prompt as context — used by `userPromptSubmit` and `sessionStart`. When absent, those stages fall back to the hook's raw stdout. |

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "permissionDecisionReason": "vetted command"
  }
}
```

```json
{ "hookSpecificOutput": { "updatedInput": { "path": "safe.txt" } } }
```

A `userPromptSubmit` (or `sessionStart`) hook contributes context via
`additionalContext` — or, absent that, its trimmed stdout — which is appended to
the task as a `<hook-context>…</hook-context>` block (capped at 8000 chars).

### `statusLine` (TUI)

A shell command whose stdout becomes a custom status-bar line in the TUI,
rendered on its own line directly below the built-in status bar. The command
runs via `/bin/sh -c` with the workspace as cwd, receives the status payload as
JSON on stdin, and the same fields as `SEEKFORGE_*` environment variables:

| Env var | Meaning |
| --- | --- |
| `SEEKFORGE_MODEL` | Active model |
| `SEEKFORGE_CWD` | Workspace directory (also the command's cwd) |
| `SEEKFORGE_SESSION_ID` | Current session id (when present) |
| `SEEKFORGE_APPROVAL` | Approval mode (`confirm` / `acceptEdits` / `auto` / `plan`) |
| `SEEKFORGE_COST_USD` | Cumulative session cost in USD |
| `SEEKFORGE_CONTEXT_PERCENT` | Context-window usage percent (when present) |
| `SEEKFORGE_TOTAL_TOKENS` | Cumulative prompt+completion tokens (when present) |

Only the first line of stdout is used, capped at 80 characters (ANSI escapes are
allowed through). A non-zero exit, a timeout (default 1.5s), or empty output
yields nothing and the TUI falls back to its built-in status line.

```json
{ "statusLine": "echo \"$SEEKFORGE_MODEL | $SEEKFORGE_CONTEXT_PERCENT% ctx\"" }
```

This key is read by the TUI only. Settable via `config set`? **No** — edit the
file directly.

### `profiles`

Named config overlays selectable at runtime with `--profile <name>` (or the
`SEEKFORGE_PROFILE` environment variable). Each profile is a partial `CliConfig`
whose fields override the merged base config when that profile is selected.

```json
{
  "model": "deepseek-v4-flash",
  "profiles": {
    "review": { "model": "deepseek-v4-pro", "thinking": true },
    "ci": { "sandbox": "restricted", "commandAllowlist": ["pnpm test"] }
  }
}
```

Selecting a profile:

```bash
seekforge run "..." --profile review
SEEKFORGE_PROFILE=ci seekforge run "..."
```

Profiles are looked up across **all** config layers. On a name clash the project
profile wins over the global one, and the local profile (`config.local.json`)
wins over both — the same precedence as the plain config layers. Deep-merge
fields (`mcpServers`, `permissionRules`, `hooks`) inside a profile are combined
across those layers like the base config.

In the precedence stack, a selected profile overlay slots **just below
`--settings` and above `config.local.json`** — see Precedence below. The
`profiles` map itself is a selection mechanism only and is **stripped** from the
config returned by `loadConfig` (so `config show` never echoes it). Available
profile names are discoverable via `availableProfiles()`.

Settable via `config set`? **No** — edit the file directly.

### Custom output styles

Beyond the four built-in output styles (`default`, `concise`, `explanatory`,
`learning`), you can define your own by dropping a Markdown file at:

- `<project>/.seekforge/output-styles/<name>.md` (project — wins), then
- `~/.seekforge/output-styles/<name>.md` (user home)

The file's body becomes the system-prompt addendum verbatim; an optional leading
YAML frontmatter block is stripped first. Select a custom style by its file name
(without `.md`) via `--output-style <name>` — the same flag the built-ins use.
Built-in names always resolve to their preset, so a file sharing a built-in name
does not override it. An unknown style (neither built-in nor a matching file)
errors.

```markdown
---
description: House style
---
## Output style: House

- Lead with the change, then a one-line rationale.
- Reference files as absolute paths.
```

---

## Precedence (layering)

Config is loaded by `loadConfig()` (`apps/cli/src/config.ts`) with this
priority, highest first:

| Layer | Mechanism |
| --- | --- |
| **Environment variables** | `DEEPSEEK_API_KEY`, `SEEKFORGE_RUNTIME_BIN` |
| **CLI flags** | `--model`, `-y`, `--settings <file>`, … |
| **`--settings <file>`** | JSON file loaded at runtime |
| **Selected `--profile` overlay** | A profile chosen via `--profile <name>` / `SEEKFORGE_PROFILE` |
| **Local config** | `<project>/.seekforge/config.local.json` (gitignored, per-developer) |
| **Project config** | `<project>/.seekforge/config.json` |
| **Global config** | `~/.seekforge/config.json` |

Scalar keys (strings, booleans) are simply overwritten — the highest layer
wins. For example, a `model` set in the project config is ignored when
`--model` is passed on the CLI.

### Deep-merge fields

Three fields merge across layers rather than replace:

| Field | Merge strategy |
| --- | --- |
| `mcpServers` | Per-server key merge: `{ ...global, ...project, ...settings }`. Later layers override individual server entries but keep servers from earlier layers that aren't redefined. |
| `permissionRules` | Concatenated: `[...settings, ...project, ...global]`. First match wins per action category, so settings-layer rules take highest file-layer precedence. |
| `hooks` | Per-stage concatenation for every stage: global → project → settings. No stage is dropped when only some stages are configured in a given layer. |

---

## `seekforge config show|set`

### Show

```bash
seekforge config show
```

Prints the **merged** config (all layers combined) as formatted JSON. The
`apiKey` value is masked to the first 6 characters (e.g. `"sk-ab1****"`).
Does not accept a `--global` flag — it always shows the merged result.

### Set

```bash
seekforge config set <key> <value>         # writes to project config
seekforge config set <key> <value> --global # writes to ~/.seekforge/config.json
```

**Settable keys** (defined in `ALLOWED_KEYS` at `apps/cli/src/commands/config.ts`):

| Key | Type in config | CLI value |
| --- | --- | --- |
| `apiKey` | string | String |
| `model` | string | String |
| `baseUrl` | string | String |
| `runtimeBin` | string | String |
| `commandAllowlist` | string[] | Comma-separated string (`"pnpm test, cargo build"`) |
| `models` | string[] | Comma-separated string (`"deepseek-v4-flash, deepseek-v4-pro"`) |
| `sandbox` | enum | `off` / `workspace-write` / `restricted` |
| `compaction` | enum | `mechanical` / `llm` |
| `thinking` | boolean | `true` / `false` |
| `reasoningEffort` | enum | `high` / `max` |

The remaining keys — `planModel`, `escalateOnFailure`,
`memoryAutoApproveConfidence`, `permissionRules`, `mcpServers`, `hooks` — are
**not settable** via `config set`. They must be edited directly in the JSON
config file, or managed through their dedicated subcommands (`seekforge mcp
add|list|remove` for MCP servers).

Attempting `config set` with an unlisted key prints an error and lists the
allowed keys.

---

## Environment variables

| Variable | Maps to | Precedence |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `apiKey` | Overrides all file/flag layers |
| `SEEKFORGE_RUNTIME_BIN` | `runtimeBin` | Overrides all file/flag layers |
| `SEEKFORGE_PROFILE` | selects a `profiles` entry | Used when `--profile` is absent; the chosen overlay slots below `--settings` |

`DEEPSEEK_API_KEY` and `SEEKFORGE_RUNTIME_BIN` are applied at the end of
`loadConfig()`, so they always win over any file or flag. `SEEKFORGE_PROFILE`
only chooses which `profiles` overlay is layered in (the explicit `--profile`
flag takes precedence over it).

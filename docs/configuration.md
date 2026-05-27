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

Settable via `config set`? **No** — edit the file directly.

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

Settable via `config set`? **No** — edit the file directly.

### `thinking`

Controls DeepSeek V4 thinking mode. When `true`, the model shows its reasoning
in a collapsible thought block (never echoed back into requests). When `false`
or absent, the API default applies.

In the REPL, `/think on|off|high|max` toggles this at runtime.

```json
{ "thinking": true }
```

Settable via `config set`? **No** — edit the file directly.

### `reasoningEffort`

V4 reasoning effort level. Only meaningful when thinking is enabled.

| Value | Behaviour |
| --- | --- |
| `"high"` | Standard reasoning depth. |
| `"max"` | Maximum reasoning depth — more thorough but slower and more expensive. |

```json
{ "reasoningEffort": "max" }
```

Settable via `config set`? **No** — edit the file directly.

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

Hook entries are concatenated per stage across config layers for three stages
that `loadConfig` explicitly merges (`preToolUse`, `postToolUse`, `sessionEnd`):
**global → project → settings**. The settings-layer hooks run last for these
stages. For all other stages (`sessionStart`, `userPromptSubmit`, `preCompact`,
`stop`, `subagentStop`, `notification`), the highest layer's hooks entirely
replace the lower layers (scalar spread semantics).

Settable via `config set`? **No** — edit the file directly.

---

## Precedence (layering)

Config is loaded by `loadConfig()` (`apps/cli/src/config.ts`) with this
priority, highest first:

| Layer | Mechanism |
| --- | --- |
| **Environment variables** | `DEEPSEEK_API_KEY`, `SEEKFORGE_RUNTIME_BIN` |
| **CLI flags** | `--model`, `-y`, `--settings <file>`, … |
| **`--settings <file>`** | JSON file loaded at runtime |
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
| `hooks` | Per-stage concatenation for 3 stages (`preToolUse`, `postToolUse`, `sessionEnd`): global → project → settings. Other stages follow scalar spread (highest layer wins). |

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

All other keys — `permissionRules`, `mcpServers`, `hooks`, `sandbox`,
`compaction`, `thinking`, `reasoningEffort` — are **not settable** via
`config set`. They must be edited directly in the JSON config file,
or managed through their dedicated subcommands (`seekforge mcp add|list|remove`
for MCP servers).

Attempting `config set` with an unlisted key prints an error and lists the
allowed keys.

---

## Environment variables

| Variable | Maps to | Precedence |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `apiKey` | Overrides all file/flag layers |
| `SEEKFORGE_RUNTIME_BIN` | `runtimeBin` | Overrides all file/flag layers |

These are the only two environment variables the config system reads. They are
checked at the end of `loadConfig()`, so they always win over any file or flag.

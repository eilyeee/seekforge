# MCP (Model Context Protocol) Guide

> **English** | [简体中文](mcp.zh-CN.md)

SeekForge implements both sides of the Model Context Protocol (MCP):

- **Client mode** — connect to external MCP servers (stdio or Streamable HTTP)
  and surface their tools, resources, and prompts to the agent.
- **Server mode** — run SeekForge itself as an MCP server on stdio so other
  agents can use this workspace's built-in tools.

---

## 1. Client Mode — Using MCP Servers

The agent interacts with configured MCP servers through three channels: **tools**
(the primary channel), **resources** (readable documents addressed by URI), and
**prompts** (server-defined templates).

### 1.1 Configuration

MCP servers are declared under `mcpServers` in `.seekforge/config.json`
(project) or `~/.seekforge/config.json` (global).

Project entries are definitions only: repository configuration cannot grant
itself automatic startup authority, so project `trusted: true` is ignored. To
trust a reviewed server, copy its complete entry to the global config and set
`trusted: true` there. Explicit management actions may still connect to a
selected untrusted project entry for testing or tool inspection.

The config format is Claude Code–compatible:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      // Optional: extra environment variables merged over process.env (stdio only)
      "env": { "MY_VAR": "value" },
      // SeekForge-specific: controls permission level (default false)
      "trusted": false,
      // Optional conservative server default + raw-tool-name overrides
      "permission": "write",
      "toolPermissions": { "read_file": "readonly", "delete_file": "dangerous" }
    },
    "web-search": {
      // Streamable HTTP transport — selected by the presence of "url"
      "url": "https://example.com/mcp",
      // Optional: extra HTTP headers sent on every request
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      },
      // Optional refresh-token flow. Secrets should use environment refs;
      // refreshed access tokens stay in memory and are never persisted.
      "oauth": {
        "tokenEndpoint": "https://example.com/oauth/token",
        "clientId": "${MCP_CLIENT_ID}",
        "clientSecret": "${MCP_CLIENT_SECRET}",
        "refreshToken": "${MCP_REFRESH_TOKEN}"
      }
    }
  }
}
```

**Transport selection** (per-server, mutually exclusive):

| Has `url`? | Transport       | Effective fields         |
|---|---|---|
| No         | stdio           | `command`, `args`, `env` |
| Yes        | Streamable HTTP | `url`, `headers`, `oauth` |

A server must have either `command` (stdio) or `url` (HTTP); having neither
causes a configuration error.

### 1.2 CLI Commands

#### `seekforge mcp list [--tools]`

Spawns every configured server, performs the initialize handshake, and prints
each server's tool names. A failing server shows its error inline and listing
continues. With `--tools`, the first line of each tool's description is shown.

```text
$ seekforge mcp list --tools
filesystem  (npx -y ..., untrusted)  2 tool(s)
  read_file  Read the complete contents of a file from the file system
  write_file  Write text content to a file at a specified path
```

#### `seekforge mcp add <name> <command> [args...]`

Appends a **stdio** server to `mcpServers` in the project config (add
`--global` for `~/.seekforge/`). The first token after `<name>` is the command;
the rest become `args`.

New project servers are **untrusted** — the CLI prints a reminder to review the
entry, then copy it to global config with `"trusted": true` before automatic
Agent connection.

```text
seekforge mcp add fs npx -y @modelcontextprotocol/server-filesystem .
```

#### `seekforge mcp remove <name>`

Deletes a server from `mcpServers`. Accepts `--global` for the global config.

#### `seekforge mcp login <name>`

Runs the interactive OAuth 2.1 authorization-code flow (PKCE, `S256`) against a
remote server that has a `url` but no `oauth` block:

1. Discovers the authorization server from
   `/.well-known/oauth-protected-resource`, falling back to the MCP server's own
   origin, and reads its `/.well-known/oauth-authorization-server` metadata.
2. Binds a one-shot listener on `127.0.0.1` and registers a client for that exact
   redirect URI (RFC 7591), or uses `--client-id` / `--client-secret` when the
   server does not support dynamic registration.
3. Opens the browser, accepts the single callback, and exchanges the code with
   the PKCE verifier. `--scope` overrides the server's advertised scopes.

The resulting refresh token is written to `~/.seekforge/mcp-oauth.json` with
owner-only permissions (`0600`), keyed by server name **and** URL — never to
`.seekforge/config.json`, which is routinely committed and shared. Repointing a
server name at a different URL therefore requires a fresh login.

Every hop is re-validated before use: endpoints must be `https` (loopback may be
`http`), the metadata `issuer` must match the discovery origin, the callback
`state` is compared in constant time, and a server advertising PKCE without
`S256` is rejected.

```text
$ seekforge mcp login docs
authorization server: https://auth.example.com/
opening your browser to authorize (paste the URL manually if it does not open):
  https://auth.example.com/authorize?response_type=code&...
stored credentials for "docs" in ~/.seekforge/mcp-oauth.json
```

#### `seekforge mcp logout <name>`

Deletes the stored credential for that server. Config-declared `oauth` blocks
are untouched.

### 1.3 Config Layering

The config merge order (later wins) is:

```text
settings file  >  project .seekforge/config.json  >  global ~/.seekforge/config.json
```

Per-server configs are shallow-merged by key: later layers override earlier
ones. A repository entry that shadows a global entry remains untrusted; trust
is never inherited across that boundary. For the full layering model see
[cli-reference.md](cli-reference.md#settings-layering).

### 1.4 Tool Naming

Every MCP server tool is registered in the agent's tool dispatcher under a
namespaced name:

```text
mcp__<server>__<tool>
```

Examples:

| Config key    | Server tool  | Registered as                  |
|---|---|---|
| `filesystem`  | `read_file`  | `mcp__filesystem__read_file`  |
| `filesystem`  | `write_file` | `mcp__filesystem__write_file` |
| `web-search`  | `search`     | `mcp__web-search__search`     |

The `inputSchema` from the server's `tools/list` response is passed through to
the model as `parametersOverride` so the model sees the real parameter schema.
Local validation uses `z.object({}).passthrough()` — actual validation is
delegated to the MCP server.

### 1.5 Protocol Version

The client advertises protocol version `2025-06-18` (the current stable MCP
revision). Servers that only speak an older revision negotiate down by replying
with their own `protocolVersion` — the client accepts this and does not enforce
an exact match (version-fallback). The version-fallback path is tested against
a `2024-11-05` server.

Client info sent in `initialize`:

```json
{ "name": "seekforge", "version": "1.0.0" }
```

### 1.6 Capabilities

Both transports advertise `roots.listChanged: true` in their initialize
capabilities. Workspace paths (absolute directories passed at startup) are
advertised to each server via the roots capability and answered on
server-initiated `roots/list` requests — over stdio directly, and over HTTP on
the standalone GET SSE stream kept open after initialization when the server
supports one. After initialization, HTTP requests
include the negotiated `MCP-Protocol-Version` header. Streamable HTTP responses
must be JSON-RPC objects whose id matches
the pending request; scalar, array, null, and mismatched-id responses are rejected.
When `oauth` is configured, an HTTP 401 triggers one standards-based
`refresh_token` exchange and retries the original request once. Config-declared
credentials are never written back, so the refreshed access token stays in
memory. When there is no `oauth` block, a credential stored by
`seekforge mcp login` is used the same way and renewed in place — a rotated
refresh token is persisted, and a response that omits one keeps the previous
token rather than dropping it. Unattended processes therefore need either a
prior `mcp login`, a configured refresh token, or a static header.

#### Sampling and elicitation

Two more requests travel server → client, and each is advertised **only when the
frontend has wired an answer for it**. A client with nothing wired reports the
capability as absent, and a conforming server never asks; if it asks anyway it
gets JSON-RPC `-32601`, not a hang.

| Capability | Method | Wired when | What happens |
| --- | --- | --- | --- |
| `sampling` | `sampling/createMessage` | the frontend has a confirm channel and a model is configured | The server's prompt is shown to you verbatim (capped) and, once you approve, run against your own model. |
| `elicitation` | `elicitation/create` | the frontend has an ask-the-user channel | The server's question is put to you, and your answer is returned. |

**Sampling spends your tokens on a prompt you did not write**, so it is confirmed
on **every** call — there is no approval-mode bypass, only whatever your
frontend's confirm does (a headless `-y` run therefore approves it, exactly as
`-y` approves everything else). The prompt names the server, the model, and the
text being sent. What the call cost is written to stderr as
`[mcp:<server>] sampling used <n> tokens ($x.xxxx)` **and** folded into the
session's own total, so it appears in `usage.updated`, in the session record,
and in whatever the frontend shows you — the same place as every other token
you paid for.

The sampling provider is built from the same configuration as the agent's but is
a separate instance, so a server's model calls stay out of the agent's retry bus
and response cache. Requests are bounded before they reach the model: at most 50
messages, 200,000 characters, text parts only. A server may also have at most
4 sampling/elicitation requests in flight at once — each one occupies a person
or a paid model call until it resolves — and is told to retry beyond that.

**Elicitation** is answered through the same channel the `ask_user` tool uses:
boolean and enumerated fields become a choice, anything else asks you to type a
value. Declining any single field declines the whole request — a server acts on
whatever it is told, so a half-answered form is worse than no answer. The
requested schema must be a flat object of primitives, as the specification
requires; anything nested is rejected.

Wired in every surface that has a user to ask: the CLI (`seekforge run`, the
REPL), the local server (the desktop and web workbenches, over the WebSocket
confirm/question channels), and the TUI. The TUI starts its MCP servers before
the app renders, so its handlers reach whichever run currently owns the screen;
a request arriving with no run active is refused rather than misrouted.

`tools/list`, `resources/list`, and `prompts/list` consume every opaque
`nextCursor`. Repeated cursors are rejected and discovery is capped at 100 pages
and 10,000 items so a malformed or hostile server cannot create an infinite
loop or unbounded catalog allocation.

### 1.7 Trust Model

Each user-owned server entry has an optional `trusted` boolean (default `false`).
Automatic agent discovery connects only global or explicitly supplied settings
entries marked `trusted: true`; repository trust flags are stripped because the
connection itself can start a local process or contact a remote endpoint.
Trusted tools use a configured raw-tool-name override first, then the server
default, then MCP annotations (`destructive`/`openWorld` escalate to `env`,
`readOnly` maps to `readonly`), and otherwise `write`. Untrusted entries remain
`env` when explicitly inspected and can never lower their permission through
annotations.

| `trusted` | Automatic connection | Tool permission | With `-y` | Without `-y` |
|---|---|---|---|---|
| `false`   | Disabled | N/A | N/A | N/A |
| `true`    | Enabled | override/default/annotation, else `"write"` | Policy-dependent | Policy-dependent |

Explicit management commands such as `seekforge mcp list` and Desktop's server
test/tool inspection can connect the selected untrusted entry because that exact
connection was initiated by the user. Mark a server trusted only after reviewing
its command or URL and configuration.

Tool results keep text under `content`, preserve bounded/redacted
`structuredContent`, and expose image/audio/resource metadata as attachment
descriptors without placing base64 payloads into the model context.

### 1.8 Resources

Configured MCP servers' resources are listable and readable. Each resource is
tagged with its server name. The programmatic surface:

- **`listMcpResources(entries)`** — returns `{ server, uri, name }` for every
  resource across all connected servers. A failing server logs a warning and
  contributes zero entries.
- **`readMcpResource(server, uri, entries)`** — reads one resource by URI from
  the named server. The response is flattened to text (binary/blob parts become
  `[binary content: image/png]`). Text is soft-capped at 50,000 characters
  (`RESOURCE_READ_MAX_CHARS`); longer responses are truncated with a
  `…[truncated]` suffix.

TUI and Server/Desktop runs expand up to five `@mcp:<server>:<uri>` references
per message before the task reaches the model. Failures are included as bounded
unavailable-resource blocks rather than aborting the whole run. Resource bodies
are serialized into an explicit untrusted-data envelope; embedded directives do
not become user instructions or change the permission policy.

### 1.9 Prompts

Configured MCP servers' prompts are listable and invocable. Each prompt is
tagged with its server name:

- **`listMcpPrompts(entries)`** — returns `{ server, name, description,
  arguments? }` for every prompt across all connected servers.
- **`getMcpPrompt(server, name, args?, entries)`** — retrieves one prompt's
  messages, flattened to a single string (`role: content` per message), capped
  at 50,000 characters.

TUI exposes prompt commands. Desktop Settings lists prompt templates, collects
their declared arguments, resolves them through the workspace-scoped server API,
and inserts the rendered prompt into the chat composer.

---

## 2. Server Mode — Running SeekForge as an MCP Server

### 2.1 CLI

```text
seekforge mcp-serve [--allow-write]
```

Runs SeekForge as an MCP server over **stdio** (newline-delimited JSON-RPC 2.0),
using the same framing the client transport uses. Protocol traffic uses stdout;
all diagnostics go to stderr. The server stays alive until the client closes
stdin.

A startup message is written to stderr:

```text
seekforge mcp-serve: read-only on /path/to/workspace
```

or with `--allow-write`:

```text
seekforge mcp-serve: FULL ACCESS (trusted callers only) on /path/to/workspace
```

### 2.2 Protocol

The server speaks protocol version `2025-06-18`. Server info:

```json
{ "name": "seekforge", "version": "1.0.0" }
```

**Supported methods:**

| Method                      | Supported | Notes                      |
|---|---|---|
| `initialize`                | ✅        | Returns tool, resource, and prompt capabilities |
| `notifications/initialized` | ✅        | Notification; no response  |
| `ping`                      | ✅        | Returns `{}`               |
| `tools/list`                | ✅        | Lists exposed tools        |
| `tools/call`                | ✅        | Executes a tool; errors return `isError: true` in the result, not a JSON-RPC error |
| `resources/list`            | ✅        | Workspace overview and Git status resources |
| `resources/read`            | ✅        | Reads an advertised workspace resource |
| `prompts/list`              | ✅        | Lists review and security-review prompts |
| `prompts/get`               | ✅        | Renders a built-in prompt |

Tool call results always contain:

```json
{
  "content": [{ "type": "text", "text": "<JSON>" }],
  "isError": false
}
```

On success `isError` is `false` and `text` is `JSON.stringify(result.data)`;
on failure `isError` is `true` and `text` is `"<code>: <message>"`.

### 2.3 Tool Set

#### Read-only (default)

In read-only mode **8 tools** are exposed, all classifying as `L0 readonly`:

| Tool            | Permission class |
|---|---|
| `read_file`     | readonly         |
| `list_files`    | readonly         |
| `search_text`   | readonly         |
| `git_status`    | readonly         |
| `git_diff`      | readonly         |
| `git_log`       | readonly         |
| `git_blame`     | readonly         |
| `git_show`      | readonly         |

The `ToolContext` runs in `"ask"` approval mode and the `confirm` callback
**always denies** — three independent layers prevent writes.

Trying to call any other tool (e.g. `write_file`) returns a JSON-RPC error:

```json
{ "code": -32602, "message": "Tool not available in read-only mode: write_file" }
```

#### Full mode (`--allow-write`)

When `--allow-write` is passed, every built-in tool except `ask_user` is
exposed. `ask_user` is excluded because MCP has no interactive human channel.

The `confirm` callback **auto-allows** permission levels:

- `L1 (write)` — auto-allowed
- `L2 (execute)` — auto-allowed
- `L3 (env)` — always denied (web fetches, dependency installs and similar
  always require a real human)

> **Security:** Full mode gives the MCP client a shell in the workspace.
> Connect it only to callers you trust with arbitrary command execution.

---

## 3. Error Handling

### Client errors

| Code               | Meaning                                       |
|---|---|
| `mcp_config`       | Missing or invalid configuration              |
| `mcp_crashed`      | Server process exited unexpectedly            |
| `mcp_timeout`      | No response within timeout (30s req, 120s h/s) |
| `mcp_error`        | Server returned a JSON-RPC error              |
| `mcp_tool_error`   | Tool call returned `isError: true`            |
| `mcp_http_error`   | HTTP transport: unreachable or non-200        |
| `mcp_parse_error`  | Unparseable response body                     |
| `mcp_write_failed` | Could not write to stdin (stdio)              |
| `disposed`         | Client disposed before request completed      |
| `unknown_server`   | Server name not in the connected set          |

### Server errors

| Code   | Meaning                              |
|---|---|
| -32601 | Method not found (e.g. prompts/list) |
| -32602 | Invalid params (bad tool name, tool not exposed) |

---

## 4. Architecture

The implementation spans two packages:

| Module              | File                                      | Role |
|---|---|---|
| `McpServerConfig`   | `packages/core/src/mcp/types.ts`          | Config schema per MCP server entry |
| `McpClient`         | `packages/core/src/mcp/client.ts`         | Client transport: stdio or HTTP |
| `McpHttpTransport`  | `packages/core/src/mcp/http.ts`           | Streamable HTTP: POST + SSE |
| `McpToolSpecs`      | `packages/core/src/mcp/tools.ts`          | Converts tools/resources/prompts |
| `McpServer`         | `packages/core/src/mcp/server.ts`         | Server mode: JSON-RPC over stdio |
| CLI client commands | `apps/cli/src/commands/mcp.ts`            | `mcp list`, `mcp add`, `rm` |
| CLI config helpers  | `apps/cli/src/mcp-config.ts`              | Read/write `mcpServers` in config |
| CLI server command  | `apps/cli/src/commands/mcp-serve.ts`      | `mcp-serve` entry point |
| Agent factory       | `apps/cli/src/agent-factory.ts`           | `prepareMcp()` spawns servers |

### Client connection lifecycle

1. `loadMcpToolSpecs(servers, workspaceRoots?)` creates one client per entry.
2. For each server: `createMcpClient({ name, config })` selects the transport
   (HTTP if `config.url` exists, otherwise stdio).
3. The first request triggers the `initialize` handshake (with 120s timeout for
   stdio to allow npx installs).
4. After handshake, `notifications/initialized` is sent.
5. `tools/list`, `resources/list`, `prompts/list` are called once and cached
   as `ToolSpec` objects.
6. `loadMcpToolSpecs` returns `{ specs, entries, dispose }`.
7. `specs` are passed to `createDefaultDispatcher(mcpToolSpecs)` alongside
   builtin tools.
8. On session end, `dispose()` kills all child processes and cancels in-flight
   HTTP requests.

### Timeouts

| Phase                             | Timeout |
|---|---|
| Handshake (stdio, covers npx)     | 120s    |
| Regular requests (all transports) | 30s     |

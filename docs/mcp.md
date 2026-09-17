# MCP (Model Context Protocol) Guide

> **English** | [简体中文](mcp.zh-CN.md)

SeekForge implements both sides of the Model Context Protocol (MCP):

- **Client mode** — connect to external MCP servers (stdio, Streamable HTTP,
  or the legacy HTTP+SSE transport) and surface their tools, resources, and
  prompts to the agent.
- **Server mode** — run SeekForge itself as an MCP server on stdio so other
  agents can use this workspace's built-in tools.

---

## 1. Client Mode — Using MCP Servers

The agent interacts with configured MCP servers through three channels: **tools**
(the primary channel), **resources** (readable documents addressed by URI), and
**prompts** (server-defined templates).

### 1.1 Configuration

MCP servers are declared under `mcpServers` in `~/.seekforge/config.json`
(user), `.seekforge/config.json` (project), or `.seekforge/config.local.json`
(this checkout only). Claude Code's project file, `.mcp.json` at the workspace
root, is read too.

Everything that ships inside the checkout — the two project files and
`.mcp.json` — is a **definition, not a grant**: repository configuration cannot
give itself automatic startup authority, so a project `trusted: true` is
ignored. A project server connects automatically only after **you approve it for
that workspace** (`seekforge mcp approve <name>`, see §1.7). A server in your
user config connects automatically when it carries `trusted: true`.

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
      // (or explicitly with "type": "http")
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
    },
    "linear": {
      // Legacy HTTP+SSE transport (MCP 2024-11-05) — only an explicit type selects it
      "type": "sse",
      "url": "https://mcp.linear.app/sse"
    }
  }
}
```

**Transport selection** (per-server, mutually exclusive):

| `type` | Otherwise | Transport | Effective fields |
|---|---|---|---|
| `"stdio"` | no `url` | stdio | `command`, `args`, `env` |
| `"http"` | `url` present | Streamable HTTP | `url`, `headers`, `oauth` |
| `"sse"` | — | legacy HTTP+SSE | `url`, `headers`, `oauth` |

A server needs a `command` (stdio) or a `url` (HTTP/SSE); a definition that has
neither, or names another `type`, is reported as invalid and never connected.
The legacy SSE transport opens one `GET <url>` event stream, waits for the
server's `endpoint` event and POSTs every message there; the announced endpoint
must be on the same origin as `url`, because those POSTs carry the same headers
and bearer token.

**`.mcp.json`** — `{ "mcpServers": { name: { "command", "args", "env" } |
{ "type": "http" | "sse", "url", "headers" } } }` — is read as a repository
layer below `.seekforge/config.json`: only those fields are kept (Claude Code's
own `oauth` block describes a different flow and is dropped), a name SeekForge's
own project file also defines loses to it, and a name your user config defines
is ignored entirely.

**`${VAR}` references.** `command`, `args`, `env` values, `url`, `headers` and
`oauth` values may reference the process environment as `${VAR}` or
`${VAR:-default}` (the default applies when the variable is unset or empty).
References expand only for a server from your user config or a project server
you approved; an unapproved project definition is used literally, so a
checkout cannot copy an environment variable into a URL or header without you
having seen the template. `seekforge mcp get` and the approval prompt always
show the unexpanded definition.

**Environment of a stdio server.** A server from your user config inherits the
whole environment, as in Claude Code. An approved project server inherits it
with secret-looking variables removed (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
`*PASSWORD*`, … — the same list `run_command` uses), except for the variables
its own `env` block names, which you saw when you approved it:

```jsonc
{ "mcpServers": { "gh": { "command": "gh-mcp", "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } } } }
```

### 1.2 CLI Commands

#### `seekforge mcp list [--tools] [-y]`

Spawns the configured servers, performs the initialize handshake, and prints
each server's tool names. A failing server shows its error inline and listing
continues. With `--tools`, the first line of each tool's description is shown.
Each line also says whether the entry came `from this repository` or
`from your config`.

**Listing is not a read: every listed server is started.** So a server the
checkout defines is started only once you approved that exact definition for
this workspace; pending and rejected ones are printed with their command or URL
and **not started**, even with `-y`. When an approved repository server is about
to start, `mcp list` also asks for the same folder-access consent
`seekforge run` asks for; `-y` pre-authorizes that, which is what CI needs.
Servers from your own global or `--settings` config are listed without a
prompt.

```text
$ seekforge mcp list --tools
filesystem  (npx -y ..., untrusted, from your config)  2 tool(s)
  read_file  Read the complete contents of a file from the file system
  write_file  Write text content to a file at a specified path
docs  (http https://docs.example/mcp, pending approval, from this repository)  not started — review with `seekforge mcp get docs`, then `seekforge mcp approve docs`
```

#### `seekforge mcp get <name>`

Prints one server's source, its standing (trusted / untrusted, or approved /
pending / rejected for a project server), its transport, and the definition
exactly as written — `${VAR}` references unexpanded. Starts nothing.

#### `seekforge mcp add [options] <name> <command-or-url...>`

Adds a server. Options go **before** `<name>`; everything after the name is the
server's own command line (so `-y` belongs to `npx`, not to SeekForge).

| Option | Meaning |
|---|---|
| `-t, --transport stdio\|http\|sse` | Default `stdio`: the first token after `<name>` is the command, the rest its args. `http`/`sse`: exactly one URL. |
| `-s, --scope user\|project\|local` | Where to write: `~/.seekforge/config.json`, `.seekforge/config.json` (default), or `.seekforge/config.local.json`. |
| `-g, --global` | Same as `--scope user`. |
| `-e, --env KEY=VALUE` | Environment variable for a stdio server. Repeatable. |
| `-H, --header "Name: value"` | HTTP header for an http/sse server. Repeatable. |
| `--trust` | Connect it automatically: in the user scope this writes `"trusted": true`; in a project scope it approves the definition just written for this workspace. |

Without `--trust`, a user-scope server is untrusted and a project-scope server
is pending approval; the CLI says which.

```text
seekforge mcp add fs npx -y @modelcontextprotocol/server-filesystem .
seekforge mcp add --transport http -H "Authorization: Bearer \${DOCS_TOKEN}" -g --trust docs https://docs.example/mcp
seekforge mcp add --transport sse --scope local linear https://mcp.linear.app/sse
```

#### `seekforge mcp add-json [--scope …] [-g] [--trust] <name> '<json>'`

Adds one definition given as JSON in Claude Code's format
(`{"type":"http","url":"…","headers":{…}}`, `{"command":"…","args":[…]}`).
Unknown fields are rejected. A project/local entry may not carry `trusted`;
use `--trust` to approve it instead.

#### `seekforge mcp import [--from claude-desktop|claude-code] [-y] [--no-trust]`

Copies server definitions from Claude Desktop
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\…` on Windows, `~/.config/Claude/…` elsewhere) and from
Claude Code's `~/.claude.json` — its user-scope `mcpServers` plus the entries it
keeps for the **current** project — into your user config. Without `--from`,
both sources are read; a name found twice keeps its first definition.

The command prints every server it would write (and why any is skipped: already
in your config, invalid, or a duplicate) before asking for confirmation; `-y`
skips the question, not the listing. Fields SeekForge has no place for are
dropped and named, including Claude Code's `oauth` block (use
`seekforge mcp login` for those servers).

**Imported servers are marked `"trusted": true`.** They come from your own
configuration files, where they were already running, and you have just seen
each definition; `--no-trust` imports them untrusted instead. Nothing is
imported from any repository's `.mcp.json` — approve those per workspace.

#### `seekforge mcp approve <name> [-y]` · `mcp reject <name>` · `mcp reset-project-choices`

Decide on a server the checkout defines, for this workspace. `approve` prints
the definition as written and asks before recording it (`-y` skips the
question); `reject` records that it must not connect, so it stops showing as
pending; `reset-project-choices` forgets every decision for this workspace. A
name your own config defines is refused — trust it there instead. See §1.7.

#### `seekforge mcp remove <name> [--scope …] [-g]`

Deletes a server from the chosen scope (default project).

#### `seekforge mcp login <name> [-y]`

Runs the interactive OAuth 2.1 authorization-code flow (PKCE, `S256`) against a
remote server that has a `url` but no `oauth` block.

You pick the name; whoever configured that entry picked the `url` it points at.
A repository layer can never repoint a server name you already own, but a name
only the checkout defines still supplies the origin this command discovers,
registers a client with, and opens your browser at. So when the entry comes from
the repository, `mcp login` prints where it is about to send you and asks for the
same folder-access consent `seekforge run` and `mcp list` ask for; `-y`
pre-authorizes it. An entry from your own global or `--settings` config needs no
prompt. A `${VAR}` in the entry's `url` expands only for your own entries and
approved project entries (§1.1), and the stored credential is keyed by the URL
actually contacted.

The flow itself:

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
settings file  >  .seekforge/config.local.json  >  project .seekforge/config.json  >  .mcp.json  >  global ~/.seekforge/config.json
```

The merge is per **server name**, not per key inside a server entry: a higher
layer that defines `myserver` **replaces** the whole entry, it does not merge
field by field. Field-by-field merging is deliberately *not* done — it would
splice a repository layer's `args`, `env`, `url` or `oauth` into an entry that
still carries your `trusted: true`. Redefine a server in a higher layer only
with the complete entry you intend to run.

Because the repository layers sit *above* global config in precedence, two
rules constrain them:

- **A repository layer may add server names, never repoint one you own.** If
  `.seekforge/config.json` (or `config.local.json`, or `.mcp.json`) defines a name that
  `~/.seekforge/config.json` or your `--settings` file already defines, the
  repository definition is ignored and SeekForge says so. A clone cannot
  redirect the `command`, `url`, `headers` or `oauth` of a server you
  configured.
- **A repository layer may only make its own entries stricter.** `trusted` is
  stripped, and `permission` / `toolPermissions` looser than `write` (i.e.
  `readonly`) are dropped — so a repository cannot pre-load an entry with
  "never ask" and have that ride along when you copy it into global config.

This holds on every surface — CLI, TUI, `seekforge serve`, and Desktop through
the server — because all four merge through the same layer algebra, which takes
each layer's origin as part of its type. The CLI prints the narrowing and
`seekforge serve` writes it to its log; the TUI enforces it silently.

A repository entry cannot shadow a global one at all — the rule above ignores it
— and a repository entry that stands alone stays unconnected until you approve
it; trust is never inherited across that boundary. For the full layering model see
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

That simple form is used only when it is unambiguous and legal as a tool name:
at most 64 characters, matching `^[A-Za-z0-9_-]+$`, and with neither the server
name nor the tool name containing `__` (which would make the three-part split
ambiguous). Anything else — a long name, a name with a space, a dot or a
slash, a server called `a__b` — falls back to a sanitized, collision-resistant
form: each segment is reduced to `[A-Za-z0-9_-]`, truncated (server to 15
characters, tool to 25) and followed by the first 10 hex characters of
`sha256(server, tool)`:

```text
mcp__<safe-server>__<safe-tool>__<10-hex-digest>
```

The digest is derived from the original names, so the mapping is stable across
runs and two tools that sanitize to the same text still get distinct names.

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
| `sampling` | `sampling/createMessage` | the frontend has a confirm channel | The server's prompt is shown to you verbatim (capped) and, once you approve, run against your own model. |
| `elicitation` | `elicitation/create` | the frontend has an ask-the-user channel | The server's question is put to you, and your answer is returned. |

Whether a model is configured is a separate question, answered when a request
actually arrives rather than at capability time. The CLI and the TUI build the
sampling provider from the run's own configuration and skip the capability
entirely when there is no API key; `seekforge serve` resolves the provider
lazily (the MCP clients exist before the agent deps that own it) and so always
advertises sampling, answering `mcp_sampling_unavailable` if no model turns out
to be configured.

**Sampling spends your tokens on a prompt you did not write**, so it is confirmed
on **every** call — there is no approval-mode bypass, only whatever your
frontend's confirm does (a headless `-y` run therefore approves it, exactly as
`-y` approves everything else). The prompt names the server, the model, and the
text being sent. What the call cost is folded into the session's own total, so
it appears in `usage.updated`, in the session record, and in whatever the
frontend shows you — the same place as every other token you paid for. Every
shipped frontend does this. An embedder that supplies no usage sink instead
gets the fallback, one line per call on stderr:

```text
[mcp:<server>] sampling used <n> tokens ($x.xxxx)
```

The two are alternatives, not both: a frontend that accounts for the usage does
not also print it.

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
a request arriving with no run active is refused rather than misrouted. A
server reconnected later from the TUI's `/mcp` panel gets the same handlers, and
the next run uses its new tools.

#### List changes

Servers may announce that a list changed. On
`notifications/tools/list_changed` the client re-lists that server's tools; a
running agent sees the new set from its **next provider turn**. A tool call
that changed its own server's list (the server notified before answering) waits
up to two seconds for that refresh, so the very next turn already has it. Tool
names are derived from the server and tool names alone, so a refresh never
renames a tool the model already knows, and a list that comes back unchanged
does not change the request at all. `prompts/list_changed` and
`resources/list_changed` are passed to the frontend (the registry's
`subscribe`), which re-reads the lists it shows.

`tools/list`, `resources/list`, and `prompts/list` consume every opaque
`nextCursor`. Repeated cursors are rejected and discovery is capped at 100 pages
and 10,000 items so a malformed or hostile server cannot create an infinite
loop or unbounded catalog allocation.

### 1.7 Trust Model

Connecting a server starts a local process or contacts an endpoint, so an
automatic connection needs someone to have vouched for the definition:

| Where the server is defined | Connects automatically when | `${VAR}` references | stdio environment |
|---|---|---|---|
| Your user config / `--settings` | it has `"trusted": true` | expanded | inherited in full |
| The checkout (`.seekforge/config.json`, `config.local.json`, `.mcp.json`) | you approved **this exact definition** for **this workspace** | expanded | secret-looking variables removed, except those its `env` names |
| The checkout, not approved (pending or rejected) | never | left literal | — |

**Approvals** live in `~/.seekforge/mcp-project-approvals.json` (owner-only),
which no checkout can write, keyed by the workspace's real path and a SHA-256
digest of the definition as written (references unexpanded, `trusted` ignored,
every other field included). Change the definition — a new argument, another
URL, one more header — and the server is pending again until you approve the new
one. `seekforge mcp approve` / `reject` / `reset-project-choices` manage them from
the CLI; frontends call the same core functions (`approveProjectMcpServer`,
`rejectProjectMcpServer`, `resetProjectMcpChoices`, `listProjectMcpServers`) and
apply a decision to a running session with the registry's `reconnect(name)`.
`seekforge mcp add --trust` approves what it writes, and `mcp import` marks what
it imports trusted (§1.2).

In **Desktop** (and any client of `seekforge serve`), Settings → MCP lists the
checkout's servers with their standing and the definition as written; Approve
and Reject record the same decision for the open workspace. The server takes
the digest of the definition you looked at and refuses the decision if the file
changed in the meantime, so you never approve a definition you did not see
(REST: `GET /api/mcp/project-servers`, `POST
/api/mcp/project-servers/:name/approve|reject`). The next run connects an
approved server.

Once connected, a trusted or approved server's tools use a configured
raw-tool-name override first, then the server default, then MCP annotations
(`destructive`/`openWorld` escalate to `env`, `readOnly` maps to `readonly`),
and otherwise `write`. A repository entry's `permission` / `toolPermissions` can
only be stricter than that (§1.3). Entries connected for an explicit management
action without either kind of standing stay at `env` and can never lower their
permission through annotations.

Explicit management actions such as Desktop's server test/tool inspection
connect the entry you selected with the standing its source gives it. An entry
from your own config is yours even when it is not `trusted` for automatic
connection, so testing it expands its `${VAR}` references like a run of a
trusted entry would. An entry from the checkout is started only once approved
for the workspace — a pending or rejected one is refused (`403`) and nothing
runs — the same rule `seekforge mcp list` follows (see §1.2). Desktop's resource
and prompt lists connect exactly the servers a run would.

Tool results keep text under `content`, preserve bounded/redacted
`structuredContent`, and describe binary content in `attachments`. **Image**
parts (PNG, JPEG, GIF, WebP; up to 8 per result and 1 MiB each) are handed to
the model as images attached to that tool result — whether they travel is the
provider's call, as for a browser screenshot — and their descriptor says
`attached: true`. Audio, other binary types, and images over those limits stay
descriptors; no base64 payload is placed in the text the model reads.

### 1.8 Resources

Configured MCP servers' resources are listable and readable. Each resource is
tagged with its server name.

The agent has two tools for them, advertised whenever a server is connected:

| Tool | Arguments | Result |
|---|---|---|
| `list_mcp_resources` | `server?` | `{ resources: [{ server, uri, name?, description?, mimeType? }] }`, at most 200; a failing server is reported under `errors` |
| `read_mcp_resource` | `server`, `uri` | `{ server, uri, note, contents: [{ uri?, mimeType?, text }] }`; text capped at 50,000 characters, image blobs attached as images, other blobs described |

Both run at `readonly` (no prompt) for trusted and approved servers — reading a
resource has the same standing as reading a file — and at `env` otherwise.
Resource content is data from the server: the result says so, secrets are
redacted, and instructions inside it are not followed.

The programmatic surface:

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

### 1.10 Tool search (deferred MCP tools)

Every request carries every tool definition, and a few MCP servers can bring
more definition tokens than the conversation itself. When the connected
servers' tool definitions exceed **`mcpToolSearchThreshold`** percent of the
request's context budget (default 10), they are **deferred**:

- each MCP tool is listed only as `name: one-line summary` inside the
  description of a `tool_search` tool;
- `tool_search` takes `query` — keywords, or `select:name1,name2` for exact
  names — and `max_results` (default 5, at most 20); it returns the matching
  tools' full schemas and **loads** them, so they are advertised in full from
  the next provider turn;
- calling a deferred tool that was not loaded fails with `tool_not_advertised`
  and a message telling the model to call `tool_search` with
  `select:<that name>` first.

Built-in tools and the two resource tools are always advertised in full.
`mcpToolSearchThreshold: 0` always defers MCP tools; `100` never does. Loaded
tools stay loaded for the rest of the session. The index only changes when a
server's tool list does, but each load does change the advertised tools, which
starts a new cached prompt prefix — that is the price of not paying for every
schema on every turn. A run with an exact `allowedTools` list is never deferred.

`tool_search` itself runs at `readonly`: it reads the catalog SeekForge already
holds and contacts no server.

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

#### Configuration

`mcp-serve` reads `.seekforge/config.json` the same way every other command
does, and applies it to the tool calls the MCP client makes:

| Key | Effect on `mcp-serve` |
|---|---|
| `permissionRules` | Applied. A deny rule blocks at every level, including a read-only call, and never prompts. In full mode an allow rule pre-authorizes a tool, `env` tools included. |
| `hooks` | Applied. `preToolUse` runs before every tool call and a non-zero exit blocks it; `updatedInput` rewrites are re-validated and re-permission-checked as usual. In full mode a hook's `allow` answers the prompt this transport otherwise refuses, as an allow rule does. `prompt` hooks cannot be evaluated here (there is no model), so they fail — and block on `preToolUse`. See [Hooks](hooks.md). |
| `sandbox` | Applied to `run_command` / `run_tests` in full mode. An unavailable sandbox mechanism fails the command rather than running it unsandboxed. |
| `commandAllowlist` | Applied, though it changes nothing here: full mode already auto-approves `execute`, and read-only mode forbids it. |
| `visionModel`, `webSearch`, `browserProfile` | Configured, but by default nothing here reaches them: `image_analyze`, `web_search`, `web_fetch` and `browser_navigate` all classify as `env` and are refused. They take effect only if one of your `permissionRules` allows that tool. |
| `mcpServers`, `runtimeBin`, model/provider keys | **Not** applied. This process runs no agent: it neither talks to a model nor connects to other MCP servers, so it has nothing to spend them on. |

Only the layers a repository cannot write reach this transport: project and
local configs contribute deny rules (and untrusted `mcpServers` definitions,
unused here), while `hooks`, `sandbox` and `commandAllowlist` come from your
user-owned config. Plugin hooks are deliberately not merged — the default here
is a read-only tool set, and a repository-supplied hook command would turn it
back into arbitrary command execution.

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

The `ToolContext` runs with `mode: "ask"` (which forbids everything above L0
outright) and `approvalMode: "confirm"` over a `confirm` callback that **always
denies** — three independent layers prevent writes.

Trying to call any other tool (e.g. `write_file`) returns a JSON-RPC error:

```json
{ "code": -32602, "message": "Tool not available in read-only mode: write_file" }
```

#### Full mode (`--allow-write`)

When `--allow-write` is passed, every built-in tool except `ask_user` is
exposed. `ask_user` is excluded because MCP has no interactive human channel.

The `ToolContext` runs with `mode: "edit"` and `approvalMode: "auto"`:

- `L1 (write)` — auto-allowed
- `L2 (execute)` — auto-allowed
- `L3 (env)` — always denied (web fetches, dependency installs and similar
  always require a real human), unless one of your own `permissionRules`
  allows that exact tool
- `L4 (dangerous)` — never run, never askable, in either mode

The `confirm` callback still **always denies**, in both modes. Auto-approval
lives in `approvalMode`, where it is scoped to the levels above; `confirm` is
then reached only by questions that genuinely need a human, and there is none.
The one that matters is the retry a command is offered when it fails inside the
OS sandbox: an auto-allowing `confirm` would answer "yes, run it unsandboxed"
to any command whose failure output merely resembles a denial, which would make
a configured `sandbox` decorative. Here that offer is declined and the sandboxed
failure stands.

> **Security:** Full mode gives the MCP client a shell in the workspace.
> Connect it only to callers you trust with arbitrary command execution.

---

## 3. Error Handling

### Client errors

| Code               | Meaning                                       |
|---|---|
| `mcp_config`       | Missing or invalid configuration              |
| `mcp_crashed`      | Server process exited unexpectedly            |
| `mcp_timeout`      | No response within the idle timeout (30s), or past the 10-minute total |
| `mcp_cancelled`    | The caller's AbortSignal fired before the request completed |
| `mcp_error`        | Server returned a JSON-RPC error              |
| `mcp_tool_error`   | Tool call returned `isError: true`            |
| `mcp_http_error`   | HTTP/SSE transport: unreachable, non-2xx, an SSE stream that closed or announced an endpoint on another origin |
| `mcp_parse_error`  | Unparseable response body                     |
| `mcp_auth_error`   | OAuth: invalid metadata/endpoint, no PKCE S256, mismatched issuer or state, or a token response without an access token |
| `mcp_pagination_limit` | A paginated list exceeded 100 pages or 10,000 items |
| `mcp_pagination_loop`  | A paginated list repeated a cursor it had already returned |
| `mcp_sampling_denied`      | The user declined the server's `sampling/createMessage` request |
| `mcp_sampling_unavailable` | The server asked to sample but this session has no model |
| `mcp_write_failed` | Could not write to stdin (stdio)              |
| `disposed`         | Client disposed before request completed      |
| `unknown_server`   | Server name not in the connected set          |

### Server errors

| Code   | Meaning                              |
|---|---|
| -32600 | Invalid request (a second `initialize`) |
| -32601 | Method not found — a method outside the table in §2.2 |
| -32602 | Invalid params (bad tool name, tool not exposed, unknown resource or prompt) |
| -32603 | Internal error — a handler threw where a tool failure would normally be reported as `isError` |
| -32700 | Parse error — a frame above the 1 MiB message limit |
| -32002 | A request arrived before `initialize` / `notifications/initialized` completed |

---

## 4. Architecture

The implementation spans two packages:

| Module              | File                                      | Role |
|---|---|---|
| `McpServerConfig`   | `packages/core/src/mcp/types.ts`          | Config schema per MCP server entry |
| `McpClient`         | `packages/core/src/mcp/client.ts`         | Client transport: stdio, HTTP or SSE |
| `McpHttpTransport`  | `packages/core/src/mcp/http.ts`           | Streamable HTTP: POST + SSE |
| `McpSseTransport`   | `packages/core/src/mcp/sse.ts`            | Legacy HTTP+SSE (2024-11-05) |
| Launch policy       | `packages/core/src/mcp/launch.ts`         | `${VAR}` expansion, stdio environment |
| Approvals           | `packages/core/src/mcp/approvals.ts`      | Per-workspace project-server decisions |
| `McpRegistry`       | `packages/core/src/mcp/registry.ts`       | Live connections, list refresh, deferral dispatcher |
| Model-facing tools  | `packages/core/src/mcp/meta-tools.ts`     | `list_mcp_resources`, `read_mcp_resource`, `tool_search` |
| `McpToolSpecs`      | `packages/core/src/mcp/tools.ts`          | Converts tools/resources/prompts |
| `McpServer`         | `packages/core/src/mcp/server.ts`         | Server mode: JSON-RPC over stdio |
| CLI client commands | `apps/cli/src/commands/mcp.ts`            | `mcp list/get/add/add-json/import/approve/reject/remove` |
| CLI config helpers  | `apps/cli/src/mcp-config.ts`              | Read/write `mcpServers` in config |
| CLI server command  | `apps/cli/src/commands/mcp-serve.ts`      | `mcp-serve` entry point |
| Agent factory       | `apps/cli/src/agent-factory.ts`           | `prepareMcp()` spawns servers |

### Client connection lifecycle

1. `loadMcpToolSpecs(servers, workspaceRoots?, signal?, handlers?, options?)`
   decides per entry whether it may connect (`mcpConnectionDecision`: trusted
   user entry, or project entry approved for `options.workspace` /
   `workspaceRoots[0]`; `options.origins` is the config merge report's
   `mcpServerOrigins`).
2. For each connecting server: `createMcpClient({ name, config, trust })`
   expands references per the trust and selects the transport (`type`, else
   HTTP if `config.url` exists, otherwise stdio).
3. The first request triggers the `initialize` handshake (with 120s timeout for
   stdio to allow npx installs).
4. After handshake, `notifications/initialized` is sent.
5. `tools/list` is called and converted to `ToolSpec` objects; it is called
   again whenever the server sends `notifications/tools/list_changed`.
6. `loadMcpToolSpecs` returns `{ specs, entries, dispose, registry }`.
7. Either `specs` (a snapshot, including the resource tools) are passed to
   `createDefaultDispatcher(specs)`, or — for list refreshes and tool search —
   `createMcpAwareDispatcher(registry)` replaces that dispatcher; the agent loop
   re-reads its catalog whenever the registry's revision moves.
8. On session end, `dispose()` kills all child processes and cancels in-flight
   HTTP requests.

### Timeouts

| Phase                             | Timeout |
|---|---|
| Handshake (stdio, covers npx)     | 120s    |
| Regular requests (all transports) | 30s idle |
| One request in total, progress included | 10 min |

The 30s is an **idle** timeout, not a deadline. Every request carries a
`_meta.progressToken`, and a `notifications/progress` naming that token re-arms
the clock: a build, a migration or a deploy that says "still working" every few
seconds is alive, and cutting it off for being slow is the wrong answer. A
server that ignores the token behaves exactly as it did before.

A heartbeat that can extend a deadline needs its own ceiling, or a server holds
the call open for as long as it likes — hence the total, which no amount of
progress extends past.

Both are `createMcpClient` options (`requestTimeoutMs`, `maxRequestTotalMs`) —
an **embedder** seam, not configuration. They are not fields of
`McpServerConfig`, and `loadMcpToolSpecs` does not forward them, so a server
entry in `.seekforge/config.json` cannot change its own timeouts and every
configured server runs on the defaults above.

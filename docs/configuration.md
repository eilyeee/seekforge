# Configuration

> **English** | [简体中文](configuration.zh-CN.md)

SeekForge reads global and repository configuration layers and supports overriding
via environment variables, CLI flags, and a `--settings` file. All config keys are
optional — the tool works out of the box with just an API key.

## File locations

| Location | Path | Created by |
| --- | --- | --- |
| **Global** | `~/.seekforge/config.json` | `seekforge config set <key> <value> --global` |
| **Project** | `<project>/.seekforge/config.json` | `seekforge config set <safe-key> <value>` (no flag) |

Both are plain JSON. `seekforge config set` writes with `0o600` permissions
(user-read-only) regardless of whether `--global` is used. Project config lives
alongside the session traces, memory, and skills that SeekForge manages under
`.seekforge/`.

Each config file must contain a JSON object. Valid JSON scalars and arrays such
as `null`, `42`, or `[]` are invalid config layers: SeekForge ignores that layer
instead of crashing, and `seekforge doctor` / TUI `/doctor` reports its path.
Wrong container shapes for `permissionRules`, `mcpServers`, and `hooks` are also
ignored; malformed permission-rule and hook entries are filtered, while valid
values from lower-precedence layers remain effective.

### Trust boundary

Project files are repository-owned input, including `.seekforge/config.json`,
`.seekforge/config.local.json`, and profiles declared in either file. They may
set ordinary preferences (`model`, `models`, `compaction`, `thinking`,
`reasoningEffort`, `planModel`, `editFormat`, UI preferences, and similar
non-authoritative fields), add `deny` and `ask` permission rules, and declare
untrusted MCP servers for explicit inspection.

They cannot supply credentials or credential destinations (`apiKey`,
`provider`, `baseUrl`), execute startup/runtime commands (`runtimeBin`, hooks,
`statusLine`, `lintCommand`, `verifyCommand`), auto-authorize actions
(`commandAllowlist`, `allow` permission rules, MCP `trusted`), change the
sandbox (`sandbox`, `sandboxNetwork`), grant access outside the project
(`additionalDirectories`), raise spending limits, auto-approve memory, or change
audit retention.
Automatic memory maintenance is also user-owned because it can archive project
facts. Those settings must come from `~/.seekforge/config.json`, environment
variables, or an explicitly selected `--settings` file. A project MCP definition
remains visible and can be tested by an explicit management action, but
`trusted: true` is ignored unless the complete entry is user-owned.

---

## Config keys

All keys belong to the `CliConfig` type (`apps/cli/src/config.ts`).

### `apiKey`

DeepSeek API key. Prefer the `DEEPSEEK_API_KEY` environment variable so the key
never touches disk — but `config set` accepts it for convenience.

```json
{ "apiKey": "sk-..." }
```

Settable via `config set`? **Yes, with `--global`**.
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

Settable via `config set`? **Yes, with `--global`**.

### `provider`

Named provider preset. Selects the API base URL, the **wire protocol**, and a
capability set in one switch. `"deepseek"` (the default when unset) targets
DeepSeek-direct with all features enabled. `"ark"` targets Volcengine Ark, an
OpenAI-compatible endpoint (see the section below). `"anthropic"` targets the
Anthropic Messages API, which is a different protocol rather than an
OpenAI-compatible one (see its section below). An explicit `baseUrl` always wins
over the preset's URL, so you can point a preset at a proxy while keeping its
protocol and capability profile.

```json
{ "provider": "ark" }
```

Leaving `provider` unset behaves exactly as before (full DeepSeek behavior).

Settable via `config set`? **Yes, with `--global`**.

### Volcengine Ark (OpenAI-compatible)

Ark is an OpenAI-compatible endpoint. To use it:

1. Set `provider: "ark"` in your config (this selects the Ark base URL
   `https://ark.cn-beijing.volces.com/api/plan/v3` and the Ark capability
   profile). Alternatively, set `baseUrl` yourself — the `ark` preset's
   capabilities still apply when `provider` is `"ark"`, and an explicit `baseUrl`
   overrides the preset URL.
2. Supply the key via the `ARK_API_KEY` environment variable (preferred) or the
   `apiKey` config field. `ARK_API_KEY` takes precedence over `DEEPSEEK_API_KEY`
   when both are set.
3. Choose a `model` from Ark's catalog:
   - `doubao-seed-2.0-code`, `doubao-seed-2.0-pro`, `doubao-seed-2.0-lite`,
     `doubao-seed-2.0-mini`
   - `glm-5.2`
   - `kimi-k2.7-code`, `kimi-k2.6`
   - `deepseek-v4-pro`, `deepseek-v4-flash`
   - `minimax-m3`, `minimax-m2.7`

```json
{ "provider": "ark", "model": "glm-5.2" }
```

```bash
export ARK_API_KEY="…"
seekforge config set provider ark --global
seekforge config set model glm-5.2
```

Because Ark is OpenAI-compatible, the DeepSeek-only behaviors are disabled under
this preset: the DeepSeek `thinking` request parameter is not sent, context-cache
hit tokens are not read, and cost/balance accounting are turned off (cost is
reported as `0` and the `/user/balance` endpoint is not queried).

### Anthropic (Messages API)

`anthropic` is the one preset that is **not** OpenAI-compatible. It speaks the
Anthropic Messages protocol (`POST {baseUrl}/messages`), authenticates with
`x-api-key` instead of a bearer token, and sends the system prompt, tool calls,
and tool results as typed content blocks. That is a translation SeekForge does
for you — the agent, tools, sessions, and everything else are unchanged.

1. Set `provider: "anthropic"` (base URL `https://api.anthropic.com/v1`).
2. Supply the key via `ANTHROPIC_API_KEY` (preferred) or the `apiKey` config
   field. This variable is read **only** when the provider is `anthropic`.
3. Choose a `model`: `claude-opus-5` (default catalog entry), `claude-sonnet-5`,
   `claude-haiku-4-5`, `claude-opus-4-8`, `claude-fable-5`. Any other Claude id
   works too; the catalog is what the model picker offers, not a whitelist.

```json
{ "provider": "anthropic", "model": "claude-opus-5" }
```

```bash
export ANTHROPIC_API_KEY="…"
seekforge config set provider anthropic --global
seekforge config set model claude-opus-5
```

What differs from the OpenAI-compatible presets:

| Behavior | On this preset |
| --- | --- |
| `thinking` | `true` requests adaptive thinking with summarized reasoning (so the reasoning stream is not blank); `false` disables it; unset sends nothing and takes the model's default — see the caveat below |
| `reasoningEffort` | Sent as the request's effort level. With `thinking: false` it is capped at `high`, which is the most the API accepts while thinking is off |
| Prompt caching | On, and the largest cost lever here: this API caches only where a request marks a breakpoint, so SeekForge marks the end of the system prompt (which covers the tool definitions) and the end of the conversation. A cached prefix bills at a tenth of the input rate on the next turn |
| Context-cache tokens | Read. Anthropic reports the *uncached remainder* as its input count, so SeekForge adds the cache read/write counts back to report the whole prompt |
| Cost | Priced from the built-in Anthropic table — `maxCostUsd` and the cost readout work without `modelPricing`. Cache writes bill at 1.25x input and are counted separately, so the reported cost can be reconstructed from the reported tokens. A model with no published rate here reports "unknown", not `0` |
| Balance | Not queried; `/user/balance` is DeepSeek's own endpoint |
| `temperature` | Never sent — the current Claude models reject sampling parameters |
| `maxTokens` | Required by the API, so an unset value becomes a default (16000) rather than being omitted |

> **Why the tool catalog is not narrowed per turn.** An obvious-looking saving
> is to send the model only the tools a task seems to need — SeekForge ships 53
> builtins, measured at 10,858 tokens of definitions, on every request. The
> arithmetic says not to. Tool definitions sit at the FRONT of the cached
> prefix, so changing them mid-run invalidates the cache for everything behind
> them, conversation included. At Opus 5 rates a cached prefix bills at a tenth
> of input, which makes the full catalog cost 1,086 tokens-equivalent per turn —
> less than a narrowed 15-tool catalog costs *uncached* (2,970). The break-even
> conversation size is negative: there is none. Measured against a 30k-token
> conversation, narrowing the catalog per turn costs about 8x more than sending
> all of it and keeping the cache.
>
> What does pay is narrowing ONCE, before the first request, where the prefix
> stays stable and cached — which is what `--allowedTools` already does. And
> the catalog is not free even cached, so `tests/agent/tool-catalog.test.ts`
> pins its size: a large MCP server can add more definition tokens than every
> builtin combined, and that should be a visible event rather than a silent
> per-turn tax.

> **Images.** On this provider a screenshot goes straight to the model:
> `browser_screenshot` attaches the PNG to the tool result that produced it, so
> the agent can look at the page instead of describing it through a second
> model. Providers whose protocol cannot carry an image say so in the result
> text rather than dropping it silently, and `image_analyze` remains the way to
> inspect an image on those.

### What "OpenAI-compatible" actually covers

Compatible endpoints agree on the protocol but differ in how they spell parts of
it. SeekForge normalizes these divergences, each pinned by a fixture in
`packages/core/tests/provider/dialects.test.ts`:

| Divergence | Handling |
| --- | --- |
| Streamed thinking as `reasoning` instead of `reasoning_content` | Both spellings accumulate into the same reasoning stream |
| Cache hits under `prompt_tokens_details.cached_tokens` instead of `prompt_cache_hit_tokens` | Both are read; DeepSeek's field wins when both appear, and the preset's `cacheHitTokens` capability still decides whether the count is reported |
| `finish_reason: "function_call"` (legacy) | Treated as `tool_calls`, so the tool calls still run |
| Tool-call deltas without `index`, or with the id only on the first chunk | Accumulated into one call per index, defaulting to index 0 |
| A tool-calling stream that ends with no `finish_reason` at all | Reported as `tool_calls` when tool calls were delivered |
| An empty `choices: []` chunk, keep-alive comments, blank lines | Ignored |

One incompatibility is deliberate: a stream that ends **without** the `[DONE]`
terminator is rejected rather than returned as a partial answer, because a cut
connection and a clean close are otherwise indistinguishable. An endpoint that
never sends `[DONE]` is not usable without a proxy that terminates properly.

Capability differences (thinking, cache-hit tokens, cost, balance) stay explicit
per preset instead of being guessed at runtime — see `PROVIDER_PRESETS`.

### `runtimeBin`

Path to the `seekforge-runtime` binary (Rust execution backend). When set, file
I/O, command execution, and git operations are delegated to a trusted Rust
binary for defense-in-depth containment re-checks. Permission decisions stay in
TypeScript.

```json
{ "runtimeBin": "/usr/local/bin/seekforge-runtime" }
```

Not everything routes through it, and the exceptions are deliberate. `repo_map`
and `find_definition` keep reading the filesystem directly: they are read-only,
they never descend a symlinked directory, they open files with `O_NOFOLLOW`, and
they reject a subtree that resolves outside the workspace — so there is no
mutation for the runtime to re-check and no containment it would add. They used
to refuse to run at all when `runtimeBin` was set, which meant turning the
runtime on silently removed the agent's two ways of orienting in a repository.

Also read from the `SEEKFORGE_RUNTIME_BIN` environment variable (highest
precedence).

Settable via `config set`? **Yes, with `--global`**.

### `commandAllowlist`

Array of command prefixes that are allowed to auto-run without confirmation
(beyond the built-in safe commands). A common use is allowing `pnpm test` or
`cargo build` so the agent runs them without prompting.

The prefix applies to one shell invocation only. Unquoted shell control syntax
(`;`, `&&`, `||`, pipes, redirects, newlines, backticks, or `$()`) disables
automatic approval for the entire command, even when its first command matches
this list. SeekForge then uses the normal confirmation flow and displays the raw
command.

```json
{ "commandAllowlist": ["pnpm test", "cargo build", "npm run"] }
```

When setting via `seekforge config set`, pass a comma-separated string:

```bash
seekforge config set commandAllowlist "pnpm test, cargo build" --global
```

Settable via `config set`? **Yes, with `--global`** (as comma-separated string).

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

Settable via CLI `config set`? **No**. It is available through Server/Desktop settings.

### `sandbox`

OS-level command sandboxing. When unset, sandboxing is off.

| Value | Behaviour |
| --- | --- |
| `"off"` (or absent) | No sandboxing; commands run as the current user. |
| `"read-only"` | Commands run inside a sandbox where the workspace is read-only (temp dirs remain writable). Network is accessible. Uses `seatbelt` (macOS) or `bwrap` (Linux). |
| `"workspace-write"` | Commands run inside a sandbox that allows writes to the workspace directory. Network is accessible. Uses `seatbelt` (macOS) or `bwrap` (Linux). |
| `"restricted"` | Like `workspace-write` but network access is blocked. |

If the requested sandbox mechanism is unavailable at runtime, the session fails
hard — it never silently falls back to unsandboxed execution. A
denial-looking sandbox failure prompts once before retrying unsandboxed.

With a write-capable level (`workspace-write`, `restricted`), the
[`additionalDirectories`](#additionaldirectories) are writable inside the
sandbox too; under `read-only` they stay read-only. To allow only some network
destinations instead of all or none, add [`sandboxNetwork`](#sandboxnetwork).

```json
{ "sandbox": "workspace-write" }
```

Settable via `config set`? **Yes, with `--global`** — validated against `off` / `read-only` /
`workspace-write` / `restricted`.

### `sandboxNetwork`

A domain allowlist for sandboxed commands, between the all-or-nothing network
of `workspace-write` and `restricted`.

```json
{
  "sandbox": "workspace-write",
  "sandboxNetwork": {
    "allowedDomains": ["registry.npmjs.org", "*.github.com", "github.com"],
    "deniedDomains": ["gist.github.com"]
  }
}
```

- `example.com` allows exactly that host; `*.example.com` allows its
  subdomains but not `example.com` itself (list both when you need both). IP
  literals and `localhost` must be listed exactly. Schemes, ports, paths and a
  bare `*` are rejected. `deniedDomains` (optional, same syntax) wins over an
  allow pattern. Any port on an allowed host is reachable.
- The proxy resolves an allowed name once and connects only to those
  addresses. A name matched only by a `*.` pattern is refused if it resolves to
  a loopback, unspecified or link-local address (such as the cloud metadata
  endpoint); list a name exactly if it is meant to reach this machine. Private
  network ranges are not blocked.
- Commands run with `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and their
  lower-case forms) pointing at a local proxy SeekForge starts on first use;
  the OS sandbox blocks every other connection, so a tool that ignores those
  variables (or speaks something other than HTTP/HTTPS, such as `git@` SSH)
  has no network. `localhost`, `127.0.0.1` and `::1` are in `NO_PROXY`.
- A refused request gets `403 Blocked by SeekForge sandbox`; the command's
  result names the blocked `host:port`, and a failed command offers the usual
  one-time unsandboxed retry.
- The allowlist only narrows. With `sandbox` unset it implies
  `workspace-write`; with `read-only` or `workspace-write` it replaces their
  open network; with `restricted` the network stays fully blocked; with
  `sandbox: "off"` it is not enforced.
- If SeekForge itself runs behind an `http://` proxy (`http_proxy` /
  `https_proxy` / `all_proxy`, honoring `no_proxy`), allowed traffic is
  forwarded through it.
- On Linux the sandbox's separate network namespace is bridged to the proxy by a
  small forwarder that runs the host's `node` inside the sandbox. On macOS,
  commands cannot open or reach other local ports while an allowlist is active.
- A malformed value is an error when the agent is built — it is never dropped,
  because dropping it would leave `workspace-write`'s network open.

This is a user-owned setting: repository config and repository profiles cannot
set it. Settable via `config set`? **No** — edit your global config (or a
`--settings` file) directly.

### `additionalDirectories`

Absolute directories outside the project that the file tools may also use —
the config-file form of `--add-dir` / `/add-dir`.

```json
{ "additionalDirectories": ["~/code/shared-lib", "/srv/fixtures"] }
```

- `read_file`, `list_files`, `search_text`, `glob`, `write_file`,
  `apply_patch`, `notebook_read`, `notebook_edit` and `image_analyze` accept
  paths inside them (the model is told to use absolute paths). Writes need the
  same approval as in the workspace; `acceptEdits` applies.
- Secret files (`.env`, keys, `.seekforge/config.json`, `.git/config`, …) stay
  unreadable at any depth, and nothing under a `.git` directory is writable.
  Symlinks that leave every granted directory are refused.
- Entries are validated on every run: `~` expands to your home directory,
  relative paths resolve against the project, and a missing path, a file, or a
  directory inside the project is skipped with a warning. Each directory is
  pinned to its real (symlink-resolved) location.
- With a write-capable `sandbox` level, commands may write there too.
- Rewind does not restore files in these directories; it reports them as
  skipped.

This is a user-owned setting: repository config and repository profiles cannot
set it. Settable via `config set`? **No** — edit your global config (or a
`--settings` file) directly.

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

### `maxCostUsd`

**Default off.** A per-run cost budget in USD. Once cumulative cost reaches it, the
run stops via the graceful cancel path (the trace is kept, so you can `resume`).
Overridden by the `--max-cost <usd>` CLI flag (which also works with `-p`). Off
when unset or non-positive. Must be a number — a string like `"0.5"` is rejected
with a clear error rather than crashing mid-run.

```json
{ "maxCostUsd": 0.5 }
```

Settable via `config set`? **No** — edit the file directly.

### `maxDurationSeconds`

**Default off.** A per-run wall-clock budget in seconds. Once the deadline
passes, the run stops via the same graceful cancel path (the trace is kept, so
you can `resume`). Overridden by the `--max-duration <seconds>` CLI flag, which
`sandbox-run` and `remote-run` forward into the container / remote host so the
budget is enforced by the run that is actually spending the time.

This is the one cap that is a **timer** rather than a check. The cost, turn and
tool-call caps are all evaluated when something happens; the runs worth bounding
by wall clock are the ones where nothing is happening — a command with no
timeout, an MCP server that stopped answering, a provider retry loop. Those emit
no events, so an event-driven check would never fire.

The deadline covers the whole invocation, not one turn: a multi-turn
`--input-format stream-json` session is still one thing you launched and walked
away from. The clock starts when the run does — startup (config, workspace
consent, MCP server spawn) is outside it, since that phase can legitimately be
waiting on you to answer a prompt. The stop is graceful, so an in-flight tool call is cancelled rather
than killed — the run can overshoot slightly, and the stop message reports the
elapsed time it actually took.

Must be a number — a string like `"900"` is rejected with a clear error rather
than silently ignored. Off when unset or non-positive.

```json
{ "maxDurationSeconds": 900 }
```

Settable via `config set`? **No** — edit the file directly.

### `modelPricing` (cost tracking on other providers)

**Default off.** Cost is answered per provider by whoever can answer it:

| Preset | Where the price comes from | Budgets work out of the box |
| --- | --- | --- |
| `deepseek`, `anthropic`, `openai` | Their published price lists ship with SeekForge | Yes |
| `openrouter` | The endpoint states the charge for every request in `usage.cost` | Yes |
| `ark`, `ollama`, a bare `baseUrl` | Nowhere — cost reports `0` | **No**, until you set `modelPricing` |

On the last row `maxCostUsd` and the Loop cost budget can never be reached,
because every request reports `0`. SeekForge says so rather than letting you
believe otherwise: the CLI, the TUI and the server each warn once per session
that no price is known, `seekforge run --max-cost` warns that the budget cannot
be enforced, and `seekforge schedule add` warns at creation — a scheduled run is
unattended, so a budget it cannot enforce is the one that matters most.

Set `modelPricing` to supply your own per-model rates and turn cost and budget
tracking on there. A model that is priced this way is priced everywhere,
including on a provider whose preset has no table.

SeekForge deliberately ships **no** price table for those providers rather than
a guessed one: a wrong rate quietly mis-bills every budget built on it, which is
worse than reporting nothing. Until you set `modelPricing`, the CLI warns once
per session that cost will report 0 for the configured model — a spend of zero
that is really "unknown" should not be mistaken for a call that was free.

It is a map of **model id → per-1M-token prices** in USD:

```json
{
  "modelPricing": {
    "doubao-seed-2.0-pro": {
      "inputCacheMissPer1M": 0.00,
      "inputCacheHitPer1M": 0.00,
      "outputPer1M": 0.00
    }
  }
}
```

> The numbers above are **placeholders** — fill in the real per-1M-token prices
> from your provider's pricing page. `inputCacheMissPer1M` is the ordinary input
> price; `inputCacheHitPer1M` only matters on providers that report cached input
> tokens (DeepSeek); `outputPer1M` is the completion price.

A model listed here is **always** priced from your rates — even on a provider
whose preset disables cost accounting — so its cost and budget tracking work. A
model on such a provider that you don't list stays `0`. DeepSeek's default
behavior (no `modelPricing`) is unchanged.

Settable via `config set`? **No** — edit the file directly.

### `inlineImages` (let the model see a screenshot itself)

**Default: follows the provider preset.** A tool that produces an image —
`browser_screenshot` today — offers the bytes along with the path. Whether they
travel to the model is the provider's answer, not the tool's: on an endpoint
that accepts images the screenshot rides along with the tool result and the
model simply looks at it; on one that does not, the result says so in text and
the picture stays reachable through [`visionModel`](#visionmodel) and
`image_analyze`.

| Preset | Images inline | Why |
| --- | --- | --- |
| `anthropic` | **On** | Every current Claude model accepts them |
| `openai` | **On** | So does every model in the shipped catalog |
| `openrouter` | **On** | A router: the model id decides, and the refusal is explicit |
| `ark` | Off | Mixed catalog — doubao-seed is multimodal, kimi and minimax are not |
| `ollama` | Off | The common pulls (`llama3.1`, `qwen2.5-coder`) are text-only |
| `deepseek` (default) | Off | DeepSeek has no vision model |

Set `inlineImages` when your model disagrees with the preset's default — a
`doubao-seed-2.0-pro` on Ark, a pulled `llava` on Ollama, or a text-only model on
an endpoint whose others have eyes:

```json
{ "provider": "ark", "model": "doubao-seed-2.0-pro", "inlineImages": true }
```

Turning it on for a model that cannot read an image makes the request **fail**,
not degrade — that is why the presets answer conservatively for a mixed catalog
instead of guessing per model id. Turning it off is always safe: the image
becomes a note naming `image_analyze`.

User-owned: it describes your endpoint and account, so a repository config
cannot set it (the same reasoning as `modelPricing`).

Settable via `config set`? **No** — edit the file directly.

### `verifyCommand`

**Default off.** A shell command (e.g. `"npm test"`) that must pass before the
run finishes **when it has edited files but not run it since the last edit**. By
default (`autoVerify`, below) the loop **runs it automatically on the finish
turn** and feeds the real result back: a passing run is accepted, a failing run
continues with the captured output so the agent fixes the actual cause. The
check fires at most once per run.

Only a foreground invocation that exits with code `0` satisfies this gate. A
background command or a completed command with a non-zero exit code does not
count as verification.

```json
{ "verifyCommand": "pnpm test" }
```

> Honest note: in earlier eval A/B the *nudge-only* form showed **no pass-rate
> benefit and ~+10% cost** on task sets that already prompt the agent to verify.
> Auto-running it (rather than relying on the model to) removes the adoption gap,
> but its net value on real tasks still wants dogfooding — hence opt-in, not a
> default. Most useful for workflows where you do *not* tell the agent to run
> tests. Edit the file directly; not settable via `config set`.

### `autoVerify`

**Default on** (only relevant when `verifyCommand` is set). The loop runs
`verifyCommand` itself on the finish turn and feeds the result back. Set to
`false` to degrade to a one-time **nudge** asking the model to run it instead —
e.g. when the command must go through the model's permission flow, or in
environments where the loop should never shell out directly. Edit the file
directly; not settable via `config set`.

> Measured (see [`evals/round-52-measurements.md`](../evals/round-52-measurements.md)):
> auto-run finished a failing-suite fixture in fewer turns and ~30% cheaper than
> the nudge-only path — the reason it defaults on.

### `lintCommand`

**Default off.** A shell command (e.g. `"pnpm lint"`) run as a **parallel gate to
`verifyCommand`**: it must pass before the run finishes **when it has edited files
but not run it since the last edit**. By default (`autoLint`, below) the loop
**runs it automatically on the finish turn** and feeds the real result back — a
passing run is accepted, a failing run continues with the captured lint output so
the agent fixes the reported issues. Fires at most once per run, and re-fires only
after a *new* edit (same gating as verify).

As with verification, only a foreground command that exits `0` satisfies the
lint gate.

```json
{ "lintCommand": "pnpm lint" }
```

Edit the file directly; not settable via `config set`.

### `autoLint`

**Default on** (only relevant when `lintCommand` is set). The loop runs
`lintCommand` itself on the finish turn and feeds the result back. Set to `false`
to degrade to a one-time **nudge** asking the model to run it instead (mirrors
`autoVerify`). Edit the file directly; not settable via `config set`.

### `editFormat`

**Default `"patch"`.** Selects the edit-format guidance in the system prompt
(guidance only — both `apply_patch` and `write_file` stay available either way):

- `"patch"` (default): guide the agent to use `apply_patch` search/replace edits.
- `"whole"`: guide the agent to prefer `write_file` (rewrite the **whole file**)
  over `apply_patch`. Use this for **small/local models** (e.g. small Ollama
  models) that mangle exact search/replace blocks — a whole-file rewrite avoids
  brittle exact-match failures.

```json
{ "editFormat": "whole" }
```

Edit the file directly; not settable via `config set`.

### `finalizeReview`

**Default off.** When the agent finishes after editing files, run a final review
of the diff before completing. If a **reviewer** specialist agent is available
(it is a built-in; present whenever subagents are loaded), the loop **dispatches
it** — a fresh-context, read-only second pair of eyes — and feeds its findings
back for the agent to address. When no reviewer is wired in, it degrades to a
one-time self-review nudge. Costs one extra turn (or one reviewer sub-run) when
it fires. Edit the file directly; not settable via `config set`.

> Measured (see [`evals/round-52-measurements.md`](../evals/round-52-measurements.md)):
> across two task families — including a fixture built so the naive fix passes
> the test but leaves a hidden edge case — review added cost with **no** success
> or quality gain on the default model (it wrote robust code unprompted). Hence
> opt-in. Revisit for a weaker model that does make the naive mistake.

### `guardNoProgress`

**Default off.** Premature-finish guard: if an **edit-mode** run declares done
having changed nothing and made almost no tool calls (a bail-out without really
investigating), nudge it once to actually work the task. Fires only on clear
non-work, and is skipped on resumed runs (where prior-run work doesn't count
toward this run). Edit the file directly; not settable via `config set`.

### `memoryAutoApproveConfidence`

**Default off.** When set to a number in `0..1`, auto-extracted memory facts whose model confidence is `>= ` the threshold are written directly to `project.md` as approved (instead of being queued as pending candidates for review); facts below the threshold still wait for `seekforge memory approve`. Inspect extraction quality first with `seekforge memory stats`. Edit the file directly; not settable via `config set`.

### `memoryMaintenance`

**Default off.** Enables deterministic maintenance of approved project memory.
Long-lived Server/Desktop, TUI, and interactive REPL processes schedule the
work while idle: the first check is 30 seconds after startup, then every 5
minutes. A tick is skipped while any process has an active Agent/Loop or memory
writer. One-shot CLI commands retain a post-write check because they have no
idle lifetime. Maintenance uses the same cross-process memory lease as manual
compaction, never calls a model, and never fails a foreground operation.

```json
{
  "memoryMaintenance": {
    "enabled": true,
    "minFacts": 100,
    "minBytes": 65536,
    "minIntervalHours": 24,
    "pruneUnusedDays": 180
  }
}
```

Maintenance becomes due when either `minFacts` or `minBytes` is reached and the
minimum interval has elapsed. The defaults are 100 facts, 65,536 UTF-8 bytes,
and 24 hours. Duplicate and near-duplicate facts are compacted deterministically.
The five-minute idle check cadence is distinct from `minIntervalHours`: the
former decides when to look, while the latter prevents successful maintenance
from running too often. Server checks re-read user configuration and the current
workspace registry each time. Timers are cancelled on shutdown; when no
long-lived SeekForge process is open, no background daemon remains.
`minFacts` is a positive integer up to 1,000,000; `minBytes` is a positive
integer up to 4 MiB; `minIntervalHours` is `0..8760`; and `pruneUnusedDays`,
when present, is `0..36500`. Unknown nested keys and non-finite values are
rejected rather than ignored.
`pruneUnusedDays` is optional and disabled by default; when present, only facts
that have never been used and are at least that old are moved to
`project-archive.md`—they are not deleted. The last successful result is stored
at `.seekforge/memory/maintenance.json` and shown in the Desktop Memory view.

This is a user-owned setting: repository config and repository profiles cannot
enable or tune it. Configure it in Desktop Settings or edit trusted global/user
settings directly. It is intentionally not accepted by CLI `config set`.

### `permissionRules`

Fine-grained allow/ask/deny permission rules that augment the built-in 5-level
permission policy. Each rule is an object:

```typescript
type PermissionRule = {
  action: "allow" | "deny" | "ask";
  /** Tool name, or a `*` glob over tool names ("*", "mcp__github__*"). */
  tool: string;
  /** What the call must match (see below). Absent = any call of that tool. */
  match?: string;
};
```

**Actions**:

- `deny` blocks the call at every level, including read-only tools, without
  asking.
- `ask` always asks — even for a read-only tool, and even when an allow rule,
  a "don't ask again" answer or an approval mode (`auto` included) would have
  run the call. The answer covers only that call: the prompt offers neither
  "for this session" nor "always". An ask rule never rescues a denied call.
- `allow` runs a matching call without asking — including `env` (L3) tools,
  which is how you pre-approve one docs domain. Allow rules never override
  ask-mode blocking and never rescue `"dangerous"`-classified calls, and they
  never apply to a shell command with control syntax (`&&`, `;`, `|`,
  redirects, `$(…)`, newlines).

**Evaluation order**: deny rules first, then ask rules, then allow rules; the
first matching rule of each action wins.

**What `match` means** depends on what the tool does:

| Tool kind | `match` | Example |
| --- | --- | --- |
| Shell commands (`run_command`, `run_tests`, `task_kill`) | Prefix on a word boundary (`pnpm test` covers `pnpm test --watch`, not `pnpm test-all`), or a pattern with `*` wildcards matched against the whole command. An allow pattern must start with a literal program name. | `"npm run *"`, `"git push *"` |
| URL tools (`web_fetch`, `browser_navigate`, classified as `GET <url>`) | A URL prefix compared by scheme, host and path (so `GET https://docs.example.com` never covers `docs.example.com.evil.net`), or `domain:<host>` for a host and all its subdomains | `"GET https://docs.example.com/guide"`, `"domain:example.com"` |
| File tools | A path prefix on a directory boundary, or a glob if it contains `*` or `?` (`**` spans directories; `[` and `{` are literal). Paths inside the workspace are compared relative to it, whether the call used a relative or an absolute path. | `"src"`, `"src/**"`, `"**/*.env"`, `"docs/*.md"` |
| Other tools with a command (`web_search`'s `SEARCH <query>`, MCP's `mcp:<server>/<tool>`) | Plain prefix | `"mcp:github/"` |

Deny and ask rules fail closed: a command rule is also tested against every
command of a compound line (`cd x && git push` meets `"git push *"`), ignoring
leading `NAME=value` assignments and a program's directory; a path rule also
matches where a symlink really points; a glob also matches the directory it
names; a URL rule also matches a URL that does not parse. Allow rules match
only what they say: a path must match both as written and as it really
resolves, so a symlink inside an allowed directory does not extend it.

Compatibility: a `*` in an existing command rule used to be a literal
character and is now a wildcard. The permission prompt never proposes a rule
containing `*` for "always allow".

Rules from different config layers are concatenated rather than replaced.
Repository layers contribute `deny` and `ask` rules only; trusted
global/settings layers may contain all three actions.

```json
{
  "permissionRules": [
    { "action": "deny", "tool": "*", "match": "**/*.pem" },
    { "action": "ask", "tool": "run_command", "match": "npm publish*" },
    { "action": "allow", "tool": "run_command", "match": "pnpm build" },
    { "action": "allow", "tool": "web_fetch", "match": "domain:docs.example.com" },
    { "action": "allow", "tool": "mcp__github__*" }
  ]
}
```

#### Refusing with a reason

When a frontend lets you type a note while refusing, the note (trimmed, at
most 2,000 characters) is appended to the denial the model reads — "The user
said: …" — so its next attempt can follow it instead of guessing.

Settable via `config set`? **No** — edit the file directly, or let the
permission prompt write one for you (below).

#### Saving a rule from the permission prompt

Every permission prompt offers three answers, not two:

| TUI key | Desktop / VS Code | Effect |
| --- | --- | --- |
| `y` | Allow once | allow this call once |
| `a` | Allow for session | allow this and similar calls for the rest of the run (not persisted) |
| `A` | Always allow | writes the rule to `~/.seekforge/config.json` |

"Similar" is deliberately narrow. For a shell command it means the same
command, optionally with more arguments. For a file tool it means the same tool
on a file directly in the same directory (resolved through symlinks):
approving `src/a.ts` covers `src/b.ts` but not `src/sub/c.ts`, the parent
directory, or another tool. For `env` (L3) tools, and for any call an `ask`
rule matched, the session option is not offered at all.

The third answer appears only when the prompt also shows the rule it would
write, and the rule shown is exactly what lands in the file. Core decides
whether to propose one at all; a frontend that has not been given a rule does
not offer the option, because it would then have to invent what to persist.

`seekforge serve` (and therefore the Desktop) writes the rule to the config of
the account running the server. That is the same trust domain: the server binds
127.0.0.1 and requires a bearer token, so whoever answers the prompt is already
the account that started it. It is deliberately narrower than what
you may write by hand:

- **Shell commands only** (`run_command`, `run_tests`, `task_kill`). A command
  is an identity you still recognize a year later, and an allow rule matches it
  on a token boundary, so `pnpm test` never covers `pnpm test-all`. The other
  rule subjects are poorer anchors: a URL prefix rule deliberately covers every
  sub-path of what it names, which is far too wide for a rule generated from
  one URL the model happened to request. Paths are excluded for the
  neighboring reason: a path is a location whose contents change under a grant
  that outlives them, and `acceptEdits` is the deliberate way to edit freely.
- **Never a compound command.** `pnpm test && curl … | sh` is not offered,
  because an allow rule never matches a command containing shell control
  syntax: the rule would save, read as a grant, and never fire.
- **Never a command containing `*`.** It would be read back as a wildcard and
  grant more than the command you approved.
- **Never `dangerous`.** Those calls are refused before any prompt.

The rule is always written to your own `~/.seekforge/config.json`, never the
project's — a repository layer contributes `deny` and `ask` rules only, so an
allow rule written there would save and then be stripped on every load. The confirmation
notice names the file, because a permission that outlives the run is one you
have to be able to find and delete. If the write fails (unparseable config,
read-only home), the approval degrades to session scope and the run continues;
the failure is reported rather than swallowed.

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
  /** Optional OAuth refresh-token flow; every string supports ${ENV_VAR}. */
  oauth?: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scope?: string;
  };
  /** Authorizes automatic connection; trusted tools run at "write" level (default false). */
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

For Streamable HTTP servers, SeekForge keeps the optional session GET event
stream open after initialization. Notifications are consumed without blocking
normal requests, `roots/list` requests are answered from the configured
workspace roots, unknown server requests receive JSON-RPC method-not-found, and
disposing the client aborts the stream. HTTP 404/405 cleanly falls back to
request-scoped responses. Refresh-token OAuth is supported; obtaining the
initial authorization grant remains a frontend/operator step. OAuth refresh,
timeouts, and non-2xx checks apply to both ordinary requests and responses to
server-initiated requests.

Servers are merged per name across config layers (later wins):
**settings > project > global**.
Project/local entries always lose `trusted`; to enable automatic connection,
put the complete reviewed entry in global config or explicit settings.

Settable via `config set`? **No** — use `seekforge mcp add/list/remove` or
edit the file directly.

### `hooks`

User-owned shell hooks that fire at various stages of the agent lifecycle.
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

Hook entries are concatenated per stage across trusted config layers for **all**
stages: **global → settings**. Repository hooks are inert. The Desktop hook
editor writes `~/.seekforge/config.json`.

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
| `updatedInput` | top-level or under `hookSpecificOutput` | Replacement tool arguments. The dispatcher applies them before the tool runs, **re-validating against the tool schema and re-running permission checks** on the new args. An invalid replacement fails the call with `invalid_hook_args`; it never falls back to executing the original input. `preToolUse` only. |
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

### `visionModel`

**Default off.** The endpoint the `image_analyze` tool sends images to. The
main coding model usually cannot see images (DeepSeek has no vision model at
all), so this is normally a different provider and a different key —
OpenAI-compatible, base URL without the trailing `/chat/completions`.

```json
{ "visionModel": { "model": "qwen-vl-plus", "baseUrl": "https://…/v1", "apiKey": "sk-…" } }
```

`apiKey` may be omitted for a keyless local endpoint. Unset, `image_analyze`
fails with `vision_unconfigured` rather than pretending to look at the picture.

User-owned: it names a credential destination, so a repository config cannot
set it. Applies to every frontend — CLI, TUI and the server alike; on the server
it is scoped per workspace, because that process runs several workspaces'
agents at the same time and a shared endpoint would send one project's image to
another project's provider.

Settable via `config set`? **No** — edit the file directly.

### `browserProfile`

**Default off.** Name of a persistent browser session profile. When set, the
browser tools start from `~/.seekforge/browser-profiles/<name>.json` and write
it back when a run finishes, so a site logged into once stays logged in. Unset,
every run starts logged out and forgets everything when it ends.

```json
{ "browserProfile": "work" }
```

It is a name, not a path, and the file it names holds live session cookies —
see [Browser / visual verification](browser.md) for why that distinction
matters, how to create the file with `playwright codegen` instead of the agent,
and what happens when a run is cancelled.

Honored by every frontend, including `seekforge serve` and the Desktop. That
took making the browser session itself per-workspace: one Chromium process, but
one context — Playwright's isolation primitive, with its own cookies and its own
pages — per workspace. Before that, a server running several workspaces at once
shared a single page between them, so a profile could not be scoped to anything.

Settable via `config set`? **No** — edit the file directly.

### `webSearch`

**Default off.** Where `web_search` sends its query. Backends are tried most
authoritative first, and each one you configure moves ahead of the ones you did
not:

| Backend | Configured with | Notes |
| --- | --- | --- |
| Brave Search API | `braveApiKey` | A real search API: JSON, one key, a free tier. Tried first — someone who set up a key meant it to answer |
| SearXNG | `searxngUrl` | JSON, no key, self-hostable |
| DuckDuckGo | — | Always present, always last. An HTML page, scraped |

```json
{ "webSearch": { "braveApiKey": "BSA…", "searxngUrl": "http://localhost:8888" } }
```

Until any of this existed `web_search` had exactly one provider — DuckDuckGo's
HTML page, scraped — and no way around it. When DuckDuckGo changes its markup or
answers with a block page, every search in every workspace comes back empty, and
no setting helps. The other two legs are the ways out: one you can host, one you
can buy.

**Only a backend that did not run hands over.** A search that ran and matched
nothing is an answer, and asking a second provider to disagree with it would
launder "no hits" into noise. The tool now reports which case it was, in
`searched` and in the note it returns, instead of one sentence covering both —
"no hits" means believe it, "the provider blocked us" means the search never
happened.

**This key is read from your own config only.** It is not among the keys a
repository's `.seekforge/config.json` can contribute (see
[configuration layers](#configuration-layers)), because a cloned repository that
could set it would choose what the model reads back from a search. It is also
per workspace, so a server serving several projects does not route one
project's searches through another's instance.

Settable via `config set`? **No** — edit the file directly.

### `locale`

UI language for the CLI and TUI chrome (progress lines, summaries, error
messages). `--help` / option text stays English.

| Value | Behaviour |
| --- | --- |
| `"en"` | English (default). |
| `"zh-CN"` | Simplified Chinese. |

Resolved once at startup: `config.locale` > `SEEKFORGE_LANG` env var >
`LC_ALL`/`LANG` > `en`.

```json
{ "locale": "zh-CN" }
```

Settable via `config set`? **No** — edit the file directly (or set
`SEEKFORGE_LANG`).

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
yields nothing and the TUI falls back to its built-in status line. Evaluation
is asynchronous so a slow command cannot freeze rendering; output is capped at
4 KiB and a timeout/overflow terminates the command's process group.

```json
{ "statusLine": "echo \"$SEEKFORGE_MODEL | $SEEKFORGE_CONTEXT_PERCENT% ctx\"" }
```

This key is read by the TUI only. Settable via `config set`? **No** — edit the
global `~/.seekforge/config.json` directly. A project-level `statusLine` is
ignored because opening a repository must not execute repository-controlled
shell code. The command receives only a minimal process environment plus the
documented `SEEKFORGE_*` fields; provider keys and unrelated host variables are
not inherited.

### Other TUI-only keys

These are read by `seekforge-tui` and by nothing else. They were live and
effective long before this section existed; the drift gate now reads `TuiConfig`
and `ServerConfig` as well as `CliConfig`, so a surface-specific key can no
longer ship undocumented.

| Key | Default | Effect |
| --- | --- | --- |
| `accent` | theme default | Accent colour, any Ink colour name. `SEEKFORGE_TUI_ACCENT` overrides it. |
| `bell` | `true` | Terminal bell on permission prompts and run completion. |
| `notify` | `true` | OS notification on the same events (macOS `osascript`, Linux `notify-send`). Set `notify` false and `bell` true to keep only the bell. |
| `vim` | `false` | Start the composer in vim mode; `/vim` toggles at runtime. |
| `mouse` | `false` | Capture the mouse for wheel scrolling. Off by default because capturing it stops the terminal from selecting text. |
| `costBudgetUsd` | unset | Stop the tab's run once observed cumulative cost reaches this. |
| `llmCache` | `false` | Cache identical non-streaming provider calls on disk under `~/.seekforge/llm-cache`. Intended for evals and subagent-heavy work, not normal sessions. |
| `routing` | unset | Back-compatible object holding `routing.planModel`, an older spelling of `planModel`; the flat `planModel` key wins when both are set. |

### Server run-retention keys

Read by `seekforge serve` only, and applied to the persistent run ledger.
`docs/cli-reference.md` describes `--loop-auto-prune` in terms of these numbers.

| Key | Default | Effect |
| --- | --- | --- |
| `runRetentionMaxCount` | `500` | Terminal runs retained in the ledger. Non-terminal runs are always kept. |
| `runRetentionMaxAgeDays` | unset | Optional age limit for terminal runs. Omit to retain by count only. |

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
| **Local config** | `<project>/.seekforge/config.local.json` (repository-trust restrictions apply) |
| **Project config** | `<project>/.seekforge/config.json` (repository-trust restrictions apply) |
| **Global config** | `~/.seekforge/config.json` |

Scalar keys (strings, booleans) are simply overwritten — the highest layer
wins. For example, a `model` set in the project config is ignored when
`--model` is passed on the CLI.

### Deep-merge fields

Three fields merge across layers rather than replace:

| Field | Merge strategy |
| --- | --- |
| `mcpServers` | Per-server key merge, **provenance-aware**. Repository layers (`.seekforge/config.json`, `config.local.json`, and profiles in either) may introduce new server names but never override a name a user-owned layer defines; their entries always lose `trusted` and any `permission`/`toolPermissions` looser than `write`. Only a complete user-owned entry can enable automatic connection. This holds on every surface — CLI, TUI, `seekforge serve`, and Desktop through the server — because all four merge through the same layer algebra, which takes each layer's origin as part of its type. Only the CLI prints the narrowing; the others enforce it silently. |
| `permissionRules` | Concatenated higher-precedence first, but repository layers contribute only valid `deny` and `ask` rules. |
| `hooks` | Per-stage concatenation across trusted layers: global → settings. Repository hooks are ignored. |

If a higher layer supplies the wrong runtime shape for one of these fields, that
value is ignored rather than replacing a valid lower-layer value.

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
seekforge config set <safe-key> <value>    # writes a safe project preference
seekforge config set <key> <value> --global # writes to ~/.seekforge/config.json
```

**Settable keys** (defined in `ALLOWED_KEYS` at `apps/cli/src/commands/config.ts`):

| Key | Type in config | CLI value |
| --- | --- | --- |
| `apiKey` | string | String |
| `model` | string | String |
| `baseUrl` | string | String |
| `provider` | string | `deepseek` / `ark` / `anthropic` / preset name |
| `runtimeBin` | string | String |
| `commandAllowlist` | string[] | Comma-separated string (`"pnpm test, cargo build"`) |
| `sandbox` | enum | `off` / `read-only` / `workspace-write` / `restricted` |
| `compaction` | enum | `mechanical` / `llm` |
| `thinking` | boolean | `true` / `false` |
| `reasoningEffort` | enum | `high` / `max` |

The remaining keys — `planModel`, `escalateOnFailure`, `maxCostUsd`,
`modelPricing`, `inlineImages`, `verifyCommand`, `autoVerify`, `lintCommand`, `autoLint`,
`editFormat`, `finalizeReview`, `guardNoProgress`,
`memoryAutoApproveConfidence`, `memoryMaintenance`, `permissionRules`,
`sandboxNetwork`, `additionalDirectories`, `mcpServers`, `hooks` — are **not
settable** via `config set`. They must be
edited directly in the JSON config file, configured through Desktop/Server where
supported, or managed through their dedicated subcommands (`seekforge mcp
add|list|remove` for MCP servers).

Attempting `config set` with an unlisted key prints an error and lists the
allowed keys.

Without `--global`, only `model`, `compaction`, `thinking`, and
`reasoningEffort` from this command's key list are accepted. Credential routing,
runtime, allowlist, and sandbox settings are user-owned and require `--global`.

---

## Environment variables

| Variable | Maps to | Precedence |
| --- | --- | --- |
| `ARK_API_KEY` | `apiKey` | Overrides all file/flag layers; wins over `DEEPSEEK_API_KEY` when both are set |
| `DEEPSEEK_API_KEY` | `apiKey` | Overrides all file/flag layers |
| `SEEKFORGE_RUNTIME_BIN` | `runtimeBin` | Overrides all file/flag layers |
| `SEEKFORGE_PROFILE` | selects a `profiles` entry | Used when `--profile` is absent; the chosen overlay slots below `--settings` |

`ARK_API_KEY`, `DEEPSEEK_API_KEY` and `SEEKFORGE_RUNTIME_BIN` are applied at the
end of `loadConfig()`, so they always win over any file or flag. `SEEKFORGE_PROFILE`
only chooses which `profiles` overlay is layered in (the explicit `--profile`
flag takes precedence over it).

These do not map to a config key — they relocate state or change how a surface
starts:

| Variable | Effect |
| --- | --- |
| `SEEKFORGE_HOME` | Root of user-owned SeekForge state, default `~/.seekforge`: the memory store, session traces, recents, and the folder-authorization store all move with it. Set it to give a machine account or a test run its own state. |
| `SEEKFORGE_NO_BROWSER` | Any non-empty value stops `seekforge mcp login` from launching the system browser. The authorization URL is always printed, so this is the path for SSH sessions and headless machines. |
| `SEEKFORGE_STATIC_DIR` | Explicit directory of the built web UI for `seekforge serve`. The Tauri shell sets it because a compiled binary's virtual filesystem defeats the default lookup relative to the server module. |
| `SEEKFORGE_DESKTOP_BOOTSTRAP_WORKSPACE` | Placeholder workspace path `serve` hosts when the Desktop starts it before the user has chosen a project. |
| `SEEKFORGE_SERVE_CMD` | Full command line (split on whitespace) the Desktop shell spawns instead of resolving `seekforge serve` on `PATH`. It wins over the `PATH` lookup, which makes it the debugging override for a locally built server. |
| `SEEKFORGE_WORKSPACE` | Workspace directory the Desktop opens, taking precedence over the process working directory. |

### Exported to hook subprocesses

Hooks do not receive these through config; the hook runner sets them on the
child process, so a hook script can read them from its own environment:

| Variable | Value |
| --- | --- |
| `SEEKFORGE_HOOK_STAGE` | The lifecycle stage that fired this hook. |
| `SEEKFORGE_TOOL` | The triggering tool's name, or empty when the stage is not tool-scoped. |

The statusline command receives its own set — see [Statusline](#statusline).

---

## Code navigation (`repo_map` / `find_definition`) & tree-sitter

Two built-in read-only tools help the agent orient in large codebases:

- **`repo_map`** — a compact structural overview (directory rollup + a one-line
  symbol outline per file). For repos above ~150 code files, a top-level overview
  is also auto-injected into the system prompt at session start, so the agent
  starts oriented. Use `path` to drill into a subtree.
- **`find_definition`** — locates where a symbol is *defined/exported* (functions,
  classes, consts, methods, components) rather than every mention.

### Task-relevant file shortlist (auto-injected)

Alongside the generic overview, the loop injects a **task-targeted** shortlist at
session start (top-level runs only): code files ranked by lexical overlap of
their **path and symbol outline** with the task, each with a one-line outline —
"here is where to look for *this* task". It reuses the memory-brief tokenizers,
so Chinese/Japanese/Korean tasks work too. It is a **cheap orientation hint, not
a search engine**: relevance that lives only in a file's *contents* (not its name
or exports) won't surface — that is what `search_text` is for, and the prompt
says so. Nothing is injected for small trees, generic tasks, or when nothing
clears the relevance floor (silence beats noise).

> Measured (see [`evals/round-52-measurements.md`](../evals/round-52-measurements.md)):
> on bug-fix tasks whose term is already greppable the shortlist showed no gain,
> but on an ask-mode task where `search_text` returns 41 noisy hits and only the
> target's path/exports match, retrieval won **3/3 reps** (~1 fewer turn, ~10%
> cheaper). Its value is concentrated on hard navigation; it never hurt, so it
> stays on. NB: the shortlist only fires on repos with ≥40 code files (the repo
> overview needs ≥150) — most small repos never trigger either.

### Hybrid extraction (optional tree-sitter, regex floor)

Symbol extraction uses a **two-backend resolver**:

1. **tree-sitter (AST)** — accurate and comment/string-aware, for
   JavaScript/JSX, TypeScript/TSX, Python, Java, Rust, Go, C, C++, C#.
2. **regex** — the dependency-free **floor**: used for every other language
   (Vue, Svelte, Ruby, PHP, …) and whenever tree-sitter is unavailable or a file
   fails to parse.

tree-sitter ships as **optional dependencies** (`web-tree-sitter` +
`tree-sitter-wasms`): installed by default so the AST path works out of the box,
but skippable (`pnpm install --no-optional`) — extraction then degrades
gracefully to the regex floor with no loss of correctness, only precision.

> Honest note: dogfooding on a real ~1100-file repo showed `repo_map` orientation
> gets reliably used, but `find_definition` adoption from the model is weak (it
> often prefers `search_text`, which also works). These tools are **available, not
> forced**; no measured efficiency win has been established.

# seekforge serve — Local Agent Server API

Started with `seekforge serve [paths...] [--workspace <p> ...] [--port 7373]`.
Hosts **one or more workspaces**: the positional paths and repeated
`--workspace` flags are deduped and resolved to absolute paths; missing paths
are warned about and skipped; when none are given it defaults to the cwd.

## Workspaces

The server holds an ordered registry of workspaces, each `{id, name, path}`
where `id` is a short stable slug of the absolute path and `name` is the
basename. The **first** workspace is the default.

- `GET /api/workspaces` → `[{id, name, path}]` (ordered; first is the default).
- Every workspace-scoped REST route accepts a `?ws=<id>` query param selecting
  the workspace. When `?ws=` is omitted it resolves to the **first** workspace
  (preserving single-workspace clients). An unknown id is `404 not_found`.
- The WS `start`/`send` frames accept an optional `ws` field (workspace id);
  omitted = first workspace. The session runs in that workspace's path. One
  connection still drives at most one running session, but different
  connections/tabs may target different workspaces.
- WebSocket frames are UTF-8 JSON **text** frames capped at 1,000,000 serialized bytes;
  binary frames are rejected even when their bytes contain valid JSON. The desktop checks
  the same shared limit before sending and preserves the draft when a task or
  loop request is too large.

The single-workspace contract is unchanged: starting with one workspace and
omitting `?ws=`/`ws` behaves exactly as before.

## Worktrees (parallel sessions)

A *worktree session* runs on an isolated `git worktree` so a chat tab can work
on its own branch and merge back when done. Creating one requires the base
workspace to be a git repository; the server runs
`git worktree add .seekforge/worktrees/<slug> -b seekforge/<slug>` (slug from
the optional `name`, else a UTC timestamp; colliding slugs get a `-2`, `-3`, …
suffix) and registers the checkout as a **workspace** with id `wt-<slug>` —
every `?ws=`/`ws:` mechanism (REST scoping, chat runs) then targets the
worktree transparently. `.seekforge/worktrees/` is appended to
`.git/info/exclude` (per-clone, never the repo's .gitignore) so checkouts stay
out of `git status`.

- `POST /api/worktrees?ws=<base>` body `{name?}` → `{id, path, branch}`.
  400 `not_a_git_repo` when the base workspace is not a git repo; 400
  `bad_request` when `ws` points at another worktree (no nesting).
- `GET /api/worktrees?ws=<base>` → `[{id, branch, path, dirty, ahead}]` for
  worktrees created from that base. `dirty` = uncommitted changes in the
  worktree; `ahead` = commits on the branch not on the base HEAD.
- `POST /api/worktrees/:id/merge` → `{merged: true}` or
  `{conflict: true, files}` (both HTTP 200). **Merge semantics:** if the
  worktree is dirty it is auto-committed first (`git add -A` +
  `git commit -m "seekforge worktree checkpoint"`) so nothing is lost, then
  the base workspace runs `git merge --no-ff seekforge/<slug>`. On conflict
  the server collects the conflicting files and runs `git merge --abort` —
  the base repo is **never left mid-merge** and the worktree (incl. its
  checkpoint commit) survives for retry. Other git failures (e.g. a dirty
  base blocking the merge) are 500 `git_error` with the git stderr.
- `DELETE /api/worktrees/:id` → `{deleted: true}` — `git worktree remove
  --force` + `seekforge/<slug>` branch delete + workspace unregister (the
  `wt-<slug>` id stops resolving). Unmerged work is lost (discard flow).

`:id` identifies the worktree (the server knows its base); the `?ws=` on
merge/delete only has to resolve to *some* registered workspace. Worktree
registrations live in server memory — after a restart the directories and
branches still exist but are no longer listed; clean them up with plain git
(`git worktree remove`, `git branch -D`). Errors: 404 `not_found` for unknown
worktree ids; all git failures are structured `{error: {code: "git_error"}}`.

## Security

- Binds **127.0.0.1 only**. Never 0.0.0.0.
- On start the server generates a random token and prints
  `http://127.0.0.1:<port>/?token=<token>`. The token gates **capability**:
  every `/api/*` request must carry `Authorization: Bearer <token>` (or
  `?token=`), and the `/ws` upgrade must carry `?token=` — anything else
  gets 401. This blocks other local webpages from driving the agent
  (CSRF/DNS-rebinding). Static files (the UI bundle) are served without
  auth: index.html's subresource requests cannot carry the token, and the
  bundle is not a secret; the UI reads `?token=` from its URL and attaches
  it to API/WS calls. The no-UI info page never includes the token.
- CORS: no `Access-Control-Allow-Origin` header at all (same-origin UI only).
- The UI (apps/desktop `vite build` output) is served statically from `/`
  when `apps/desktop/dist` exists; otherwise `/` returns a plain info page.
  The static root is canonicalized and assets are opened without following
  symlinks; a symlink inside the bundle cannot expose a file outside it.

## REST (all JSON; prefix /api)

All workspace-scoped routes below take an optional `?ws=<id>` (default: first
workspace). `GET /api/health` and `GET /api/workspaces` are global.

| Method/Path | Response |
| --- | --- |
| GET /api/health | `{version, protocolVersion, capabilities, ready, workspace, workspaces}` (global) |
| GET /api/ready | `{ready:true, version}` readiness probe (global) |
| GET /api/metrics | Prometheus text metrics for HTTP and run lifecycle counters (global) |
| GET /api/runs | latest snapshot of every append-only run in the selected workspace |
| GET /api/runs/:id | one run snapshot (`runId/source/status/attempt/sessionId/costUsd/error`) |
| GET /api/runs/:id/events?afterSeq=N | at most 500 persisted WS events with `seq > N`, returned as `{events,nextAfterSeq,hasMore}`; continue with `nextAfterSeq` while `hasMore` |
| POST /api/runs/:id/cancel | cooperatively cancel an active run; terminal runs are returned unchanged. Returns 409 when the run is owned by another server process, because this process cannot signal its `AbortController` |
| DELETE /api/runs/:id | alias of the cancel endpoint |
| POST /api/runs | start a disconnect-independent headless run. Body `{kind:"agent"|"loop"?, task, mode:"ask"|"edit"?, maxCostUsd, verifyCommand?, maxIterations?, requirementMode?:"quick"|"analyze"|"confirm", isolation?:"auto"|"workspace"|"worktree"}`; writable runs default to worktree isolation in git repositories, loops require `verifyCommand`, default to `mode:"edit"`, and reject `mode:"ask"`; returns `202 RunRecord` immediately |
| POST /api/runs/prune | compact run history immediately. Optional body `{maxTerminalRuns?, maxAgeDays?}` overrides the workspace retention policy for this prune; active runs are always retained; returns `{removed, kept}` |
| GET /api/workspaces | `[{id, name, path}]` (global; ordered, first is the default; includes registered worktrees `wt-<slug>`) |
| POST /api/worktrees | body `{name?}` → `{id, path, branch}` — create a worktree session (see "Worktrees"); 400 `not_a_git_repo` |
| GET /api/worktrees | `[{id, branch, path, dirty, ahead}]` — worktrees of the `?ws=` base workspace |
| POST /api/worktrees/:id/merge | `{merged: true}` \| `{conflict: true, files}` — dirty worktree auto-committed; conflicts abort cleanly |
| DELETE /api/worktrees/:id | `{deleted: true}` — remove worktree + branch, unregister the workspace |
| GET /api/project | `{path, name, detect: {languages, packageManager, frameworks, scripts}}` |
| GET /api/sessions | `SessionMeta[]` (newest first, subagent sessions hidden) |
| GET /api/diff[?staged=1] | `{diff, truncated}` — workspace `git diff` (2 MB cap) |
| GET /api/files[?q=] | `{files: string[], truncated}` — workspace-relative paths (BFS, shallow first; skips the tools' DEFAULT_IGNORE_DIRS, dot-directories, and symlinks; capped at 2000, `truncated: true` when the cap cut the scan short). `q` is a case-insensitive substring filter on the relative path, applied while scanning. Feeds the web composer's `@` file picker. |
| GET /api/search?q=`<term>`[&case=1][&regex=1] | `{hits: [{path, line, text, col, len}], truncated, error?}` — project-wide content search over the same ignore-aware file set as `/api/files`. `q` is matched literally by default; `regex=1` treats it as a JS regex; `case=1` makes it case-sensitive (default: case-insensitive). Records the **first** non-empty match per line: `path` (workspace-relative), `line` (1-based), `text` (the matched line, clipped to 240 chars), `col` (0-based match offset within `text`) and `len` (match length). Empty `q` → no hits. **Bounded on every axis:** ≤1500 files scanned, files >500 KB or binary skipped (size checked via stat before reading), ≤200 hits, and a 3 s wall-clock budget; `truncated: true` when any cap (hit limit, time budget, or the file-list cap) cut the search short. In regex mode lines longer than 2000 chars are skipped and the time-box doubles as a ReDoS guard. An invalid regex returns `{hits: [], truncated: false, error: "invalid regex"}` (HTTP 200, not an error response). |
| GET /api/tree[?path=`<relative>`] | one workspace directory listing for the file browser; directories first, ignored/dot/sensitive entries hidden |
| GET /api/file?path=`<relative>` | `{path, content, truncated}` for a regular text file confined to the workspace; content is capped at 1 MB, while binary, sensitive, symlinked, and escaping paths are rejected |
| PUT /api/file | body `{path, content}` → `{ok:true}`; creates/replaces a workspace text file after the same confinement checks. Returns 409 `session_busy` while an Agent session owns the workspace, preventing editor writes from racing Agent changes |
| POST /api/upload | body `{name, dataBase64}` — saves a pasted/dropped image to `.seekforge/uploads/img-<stamp>.<ext>` and returns `{path}` (workspace-relative; core `image_analyze` consumes it). Only the extension of `name` is used (png/jpg/jpeg/gif/webp); decoded size capped at 4 MB; `dataBase64` may carry a data-URL prefix. Errors: 400 `bad_request` (bad JSON/fields/extension/base64), 413 `too_large`. |
| GET /api/raw?path=`<workspace-relative>` | streams the raw image bytes with the matching `Content-Type` (png/jpg/jpeg/gif/webp) so the UI can render real `<img>` thumbnails of uploaded images. **Hard-confined**: `path` must resolve to a regular file *inside* the physical `.seekforge/uploads/` directory of the workspace — traversal (`..`), absolute paths, any symlinked path component, and paths outside `.seekforge/uploads/` are refused. This is deliberately NOT a general file-serving endpoint. Cached `immutable` (upload names are unique). Errors: 400 `bad_request` (missing/escaping/outside-uploads path), 415 `unsupported_media_type` (non-image extension), 404 `not_found` (missing/not a file), 413 `too_large` (over 8 MB). Like all `/api/*` routes the token is required; `<img>` tags pass it via `?token=`. |
| GET /api/sessions/:id | `{meta: SessionMeta, messages: ChatMessage[], events: AgentEvent[]}`; events let Desktop reconstruct persisted subagent state |
| GET /api/sessions/:id/turns | `[{turn, text, backtrackable}]` — every `role:"user"` message of messages.jsonl in file order, numbered 0..N-1 (the same all-user-messages indexing the core's truncateSessionAtUserTurn / rewindSessionToTurn use). Turn 0 (the original task) has `backtrackable: false`; `[]` when no messages.jsonl exists yet; 404 unknown session |
| POST /api/sessions/:id/backtrack | body `{turn: integer, files?: boolean}` — truncates the conversation to just before user turn `turn` (truncateSessionAtUserTurn) and, when `files` is true, restores the file checkpoints of turns >= `turn` (rewindSessionToTurn). Returns `{removedMessages, keptMessages, files}` where `files` is `{restored, deleted, skipped}` counts, or `null` when file restore was not requested. 400 when `turn` is 0 or out of range, 404 unknown session |
| GET /api/todos | `[{index, text, done}]` — checklist lines of `.seekforge/todos.md` (same format contract as the TUI; 1-based indices count checklist lines only) |
| POST /api/todos | body `{op: "add", text}` \| `{op: "toggle"\|"remove", index}` — atomically mutates `.seekforge/todos.md` without following project symlinks, preserving every non-checklist line (headings/prose) verbatim; returns the updated todo list. 400 bad op/args, 404 index out of range, 409 while the workspace is active |
| GET /api/balance | `{balance: {currency, totalBalance} \| null}` — DeepSeek account balance fetched with the server's key. Null-safe: missing key or any fetch failure returns `{balance: null}`, never an error |
| POST /api/provider/verify | Non-billable first-run DeepSeek credential/connectivity check. Body `{apiKey}`; returns `{ok:true}` or `{ok:false,reason}` and never persists or echoes the key |
| GET /api/mcp/resources | `{resources: [{server, uri, name?}]}` — resources/list of every explicitly trusted MCP server (spawned on demand with the workspace advertised as a filesystem root, then disposed). An untrusted, failed, or unsupported server contributes zero entries |
| GET /api/mcp/prompts | `{prompts: [{server, name, description?, arguments?}]}` — prompts/list of every explicitly trusted MCP server (spawned on demand, then disposed). An untrusted, failed, or unsupported server contributes zero entries. Mirrors GET /api/mcp/resources |
| POST /api/mcp/prompts/:server/:name | body `{arguments?: object}` → `{text}` — resolves one prompt from an explicitly trusted MCP server in the selected workspace; 403 untrusted server, 404 unconfigured server, 502 MCP failure |
| GET /api/skills | `Skill[]` (without `content`) |
| GET /api/skills/:id | full `Skill` |
| GET /api/memory | `{projectMd: string \| null, candidates: MemoryCandidate[]}` |
| POST /api/memory/:id/approve | updated `MemoryCandidate` |
| POST /api/memory/:id/reject | updated `MemoryCandidate` |
| GET /api/output-styles | `{styles: [{name, kind: "builtin"\|"custom"}]}` — selectable output styles: the in-package built-ins plus every custom `.seekforge/output-styles/*.md` of the workspace |
| POST /api/commands/expand | body `{name, args}` → `{text}` — expands a custom slash command server-side: interpolates `args` into `$ARGUMENTS` / `$1`..`$9` and runs any ``!`shell` `` injections in the workspace (`/bin/sh -c`, 10 s timeout, 1 MB stdout cap; cwd = workspace), returning the final text. Shell expansion shares the repository/workspace mutation guard and returns 409 while another process owns the workspace. `name` resolves over the project + user command layers (project wins); 400 on missing/empty `name`, 404 `unknown command: <name>` |
| GET /api/hooks | `{hooks}` — the project hooks block from `.seekforge/config.json` (`{}` when none) |
| PUT /api/hooks | body `{hooks}` — replaces the project `.seekforge/config.json` hooks block (other config keys preserved; an empty/omitted hooks block is dropped from the file), returns `{hooks}`. Validated against the 9 stages (`preToolUse`, `postToolUse`, `sessionStart`, `userPromptSubmit`, `preCompact`, `stop`, `subagentStop`, `notification`, `sessionEnd`); each entry needs a non-empty `command` plus optional string `match`/`pattern`. 400 on an unknown stage or malformed shape; 409 `session_busy` while a workspace session owns the project settings layer |
| GET /api/config | config with `apiKey` masked (`sk-xxx****`), plus `{model, baseUrl, runtimeBin, commandAllowlist}` and the engine knobs `{sandbox, compaction, thinking, reasoningEffort}` (always present, with effective defaults `"off"` / `"mechanical"` / `false` / `null`); `mcpServers` is omitted (env values may be secret — see GET /api/mcp) |
| GET /api/agents | `AgentDefinition[]` without prompt bodies (id, name, scope, mode, model?, tools?, description, triggers, ...) |
| GET /api/agents/:id | full definition incl. prompt body (404 unknown) |
| GET /api/evolution | `EvolutionProposal[]` (pending first, newest first within each group) |
| POST /api/evolution/:id/accept\|reject\|apply | updated proposal (apply returns `{proposal, changedPath}`); 404 unknown id, 409 on wrong-state transitions and apply failures (e.g. skill_exists) |
| GET /api/mcp | effective global/project servers with transport, scope, shadowing, and masked env/header/OAuth values; project entries shadow same-name global entries |
| POST /api/mcp | add/update one scoped stdio or HTTP server; accepts structured `args`, `env`, `headers`, and optional refresh-token `oauth`; masked sentinels preserve existing secrets. The complete read/merge/write is serialized per selected layer; 409 `session_busy` when that layer is owned |
| DELETE /api/mcp/:name?scope=project\|global | remove one server from the selected config layer; 409 `session_busy` when that layer is owned |
| POST /api/mcp/:name/test | connect, list tools, dispose, and return `{ok, latencyMs, toolCount}` |
| POST /api/mcp/:name/tools | spawns the server, lists tools `{tools: {name, description}[]}`, disposes; 404 unconfigured, 502 `{error:{code:"mcp_error"}}` on launch/handshake failure |
| GET /api/security | current repository evidence package (Findings, scans, fixes, threat models, events) |
| POST /api/security/scan | run a repository scan; optional body `{maxFindings:1..100}` |
| POST /api/security/threat-model | generate and persist an evidence-backed threat model |
| POST /api/security/findings/:id/status | body `{status, reason?}`; records a validated Finding lifecycle transition |
| POST /api/security/findings/:id/fix | body `{maxCostUsd, verifyCommand, lintCommand?}`; runs a cost-bounded edit Agent, exact sandboxed checks, and a fresh scan |
| GET /api/security/export?format=json\|markdown\|sarif | rendered compliance evidence package and filename |
| POST /api/rewind | body `{sessionId, dryRun?}` → rewindSession result; 404 on unknown session or zero checkpoints |
| PUT /api/config | body `{key, value, global?}` — same keys/validation as `seekforge config set`; 400 on unknown key. Project updates share the repository/workspace session guard; global updates use a separate cross-process settings lease; conflicts return 409 `session_busy` |
| GET /api/triggers | webhook triggers `{id, task, mode, maxCostUsd, secret:"***", enabled}[]` — secrets always masked |
| POST /api/triggers | body `{id, task, mode:"ask"\|"edit", maxCostUsd, secret, enabled?}` → `201` masked trigger. `maxCostUsd` and `secret` (≥8 chars) are **required**; 400 on missing/invalid, 409 duplicate id |
| DELETE /api/triggers/:id | `{deleted: true}`; 404 unknown id |
| POST /api/triggers/:id | **fire** the trigger — start a headless, cost-bounded run → `202 {sessionId, triggerId}`. Generic callers use server bearer token + `x-seekforge-trigger-secret` (or `?secret=`). Native GitHub webhooks may instead authenticate with `X-Hub-Signature-256` over the exact raw body plus `X-GitHub-Delivery` and an allowed `X-GitHub-Event`; this signed route is the only `/api` bearer-token exception. Optional JSON is summarised into the task. 400 malformed/unsupported event metadata, 401 missing server token for generic calls, 403 bad secret/signature, 404 unknown id, 409 disabled/duplicate delivery. |

Errors: `{error: {code, message}}` with appropriate HTTP status.

### Event-triggered automation (webhooks)

`POST /api/triggers/:id` fires a webhook trigger: it starts a **headless,
cost-bounded** agent run of the trigger's task and returns `202` with the new
(auditable) session id. Safety invariants — see
[docs/automation.md](../../docs/automation.md):

- **Generic caller auth.** CI/services present both the server bearer token and
  trigger secret; secret comparison is constant-time.
- **Native GitHub auth.** GitHub signs the exact body with the trigger secret in
  `X-Hub-Signature-256`. Signed deliveries require a unique
  `X-GitHub-Delivery`, are deduplicated for 24 hours with a bounded persisted
  store protected by a cross-process lease, and accept only `push`, `pull_request`, `issues`, `issue_comment`, and
  `workflow_run`. No server bearer token is required for this one fire route;
  management routes remain bearer-protected.
- **Bounded + headless.** `maxCostUsd` is mandatory (unbounded triggers are
  rejected at creation) and the run aborts on reaching it. The run is
  non-interactive: the approval callback auto-denies anything that would prompt
  (dangerous stays denied, commands/env refused); an `edit` trigger runs in
  *acceptEdits* so in-workspace edits still apply. Triggers persist to the
  workspace `.seekforge/triggers.json` (owner-only, `0600`).

## WebSocket (path /ws?token=...)

One WS connection drives at most one *running* session at a time.
All frames are UTF-8 JSON text objects with a `type` field and are capped at 1 MB
before JSON parsing. A larger frame closes the connection with WebSocket code
1009; a binary frame receives `bad_frame`. Every client frame is decoded by the
shared runtime protocol boundary (`@seekforge/shared/ws-protocol`) before it can
reach connection state. The decoder validates every frame variant, optional
field, enum, numeric limit, and safe id; TypeScript's `ClientFrame` type is not
treated as runtime validation.

The server first sends `{"type":"hello","protocolVersion":1,"capabilities":[...],"disconnectPolicy":"cancel","backgroundDisconnectPolicy":"continue"}`.
Every accepted run receives a stable `runId`; persisted run frames carry a
strictly increasing `seq`. A reconnecting client sends
`{"type":"subscribe","runId":"...","afterSeq":42,"ws":"..."?}` to replay
missing frames and then continuously follow newly persisted frames. A
subscription ends after it observes a terminal Agent/Loop/error frame or the
connection closes. Disconnect remains fail-closed: it immediately cancels an
active run, denies pending prompts, and retains emitted frames for replay.
This cancel-on-disconnect rule applies only to runs started by that WS. Runs
started through `POST /api/runs` are headless, deny interactive approvals, and
continue independently when subscribers disconnect.

Writable Agent, Loop, background, webhook, and Security runs are serialized by
a cancellable cross-process workspace lease. Separate server instances cannot
edit the same workspace concurrently; read-only ask runs remain parallel.

### client → server

```jsonc
{"type": "start",  "task": "...", "mode": "edit"|"ask", "approvalMode": "auto"|"confirm", "plan": true?, "ws": "<id>"?,
                   "model": "deepseek-v4-pro"?, "thinking": true?, "reasoningEffort": "high"|"max"?}
{"type": "send",   "sessionId": "...", "task": "...", "mode": "edit"?, "ws": "<id>"?,   // continue; mode overrides
                   "model": "..."?, "thinking": true?, "reasoningEffort": "high"|"max"?} // the session's own (plan -> execute)
{"type": "permission.response", "requestId": "p1", "approved": true}
{"type": "question.answer", "id": "q1", "answer": "Option A"} // answer a pending question.request
{"type": "loop", "task": "...", "verifyCommand": "pnpm test", "maxIterations": 8?, "budget": 0.5?, "requirementMode": "quick"|"analyze"|"confirm"?, "ws": "<id>"?,
                 "model": "..."?, "thinking": true?, "reasoningEffort": "high"|"max"?}
                 // quick: verifier-only; analyzed modes also require acceptance evidence
{"type": "loop.resume", "loopId": "loop-...", "addedIterations": 2?, "addedBudget": 0.25?, "approveRequirements": true?, "ws": "<id>"?}
{"type": "subagent.steer", "dispatchId": "ag-1", "message": "focus on the parser tests"}
{"type": "subagent.cancel", "dispatchId": "ag-1"}       // cancel one child; parent run continues
{"type": "cancel"}                                            // cancel the running session OR loop
{"type": "subscribe", "runId": "run-...", "afterSeq": 42, "ws": "<id>"?}
```

`model` / `thinking` / `reasoningEffort` are optional per-run overrides on
`start`, `send`, and `loop`: when present they win over the workspace config for
that run/loop only (a fresh agent/provider is assembled; nothing is written to
config). Omitted fields fall back to config. Invalid values (empty model,
non-boolean thinking, an effort other than `"high"`/`"max"`) →
`{"type":"error","code":"bad_frame"}`. On `loop`, `maxIterations` must be a
positive integer, `budget` a finite positive number, and `requirementMode` one
of `quick|analyze|confirm` when present (else `bad_frame`). Resume cannot change
the persisted mode; `approveRequirements: true` releases a confirm-mode gate.

`ws` selects the workspace id (default: first workspace when omitted). The run
executes in that workspace's path; `send` looks the session up in that
workspace. An unknown `ws` id → `{"type":"error","code":"unknown_workspace"}`.

`subagent.steer` queues guidance for a running child and injects it only at the
next model-turn boundary; it does not cancel or resume the child session. Messages
are trimmed, limited to 4000 characters, and each dispatch has a bounded queue.
`subagent.cancel` gives that child the distinct `cancelled` terminal state. Both
frames are bound to the normal Agent run currently owned by this connection;
unknown, completed, or stale dispatch ids fail closed. They are unavailable for
an idle connection or an auto-loop run. Extra fields and malformed ids/messages
return `bad_frame`.

### server → client

```jsonc
{"type": "hello", "protocolVersion": 1, "capabilities": ["runs.v1", "ws.replay", "runs.background"], "disconnectPolicy": "cancel", "backgroundDisconnectPolicy": "continue"}
{"type": "run.accepted", "runId": "run-...", "status": "queued", "seq": 1}
{"type": "event", "sessionId": "...", "event": <AgentEvent>}  // every AgentEvent, incl. session.completed/failed
{"type": "permission.request", "requestId": "p1", "request": <PermissionRequest>}
{"type": "question.request", "id": "q1", "question": "...", "options": ["...", "..."]}  // ask_user tool
{"type": "loop.event", "event": <LoopEvent>}                  // includes requirements.*, iteration.*, verify, and loop.done
{"type": "error", "code": "...", "message": "..."}            // protocol-level errors (bad frame, busy, ...)
{"type": "idle"}                                              // sent when a run/loop finishes and a new start/send/loop is accepted
```

Run snapshots are append-only JSONL at `.seekforge/runs.jsonl`; replay frames
are stored under `.seekforge/run-events/<runId>.jsonl`. Ledger appends and
compaction share a cross-process lease. `GET /api/runs/:id/events` streams the
event log and returns at most 500 events per page as
`{events,nextAfterSeq,hasMore}`; while `hasMore` is true, pass `nextAfterSeq`
back as `afterSeq`. Sequential pages reuse a validated byte cursor while the
event file identity is unchanged, so replay work is linear in the returned page
rather than repeatedly scanning the entire prefix. Terminal history remains
queryable after restart. Nested
frame strings are redacted before JSON
serialization, and ledger writes and compaction cleanup reject symlinked project
path components. A frame that would exceed the replay JSONL line limit is
rejected before append, so one oversized event cannot hide all later replay
history. `seq` is scoped to one run. Snapshot status is one of
`queued`, `running`, `waiting`, `succeeded`, `failed`, or `cancelled`;
`waiting` is a non-failure terminal snapshot used when a confirm-mode Loop has
persisted requirements and awaits an explicit resume approval.

Automatic ledger compaction retains 500 terminal runs by default. A workspace
may set `runRetentionMaxCount` and/or `runRetentionMaxAgeDays` in
`.seekforge/config.json`; non-terminal runs are never pruned. Removing a ledger
record also removes its per-run replay JSONL on a best-effort, path-safe basis.

Dispatched children are observable through structured `AgentEvent` variants:

```jsonc
{"type":"subagent.started",   "dispatchId":"ag-1", "agentId":"reviewer", "task":"...", "status":"running"}
{"type":"subagent.step",      "dispatchId":"ag-1", "agentId":"reviewer", "task":"...", "status":"running", "toolName":"read_file", "subSessionId":"..."?}
{"type":"subagent.completed", "dispatchId":"ag-1", "agentId":"reviewer", "task":"...", "status":"done", "resultSummary":"...", "subSessionId":"..."?}
{"type":"subagent.failed",    "dispatchId":"ag-1", "agentId":"reviewer", "task":"...", "status":"failed", "error":{"code":"...","message":"..."}, "resultSummary":"..."}
{"type":"subagent.cancelled", "dispatchId":"ag-1", "agentId":"reviewer", "task":"...", "status":"cancelled", "reason":"..."}
```

The legacy `step.started` title (`[agentId] toolName`) is still emitted for old
clients, but new clients should use the structured events and identify a child by
the parent run/session plus `dispatchId`.

Rules:
- `start`/`send` while a run is active → `{"type":"error","code":"busy"}`.
- `send` resumes the session with its original ask/edit mode and
  `approvalMode: "confirm"`; an unknown session id →
  `{"type":"error","code":"unknown_session"}`.
- `permission.request` pauses the run until the matching `permission.response`
  arrives (or the socket closes, or 120 s pass without a response — both
  treated as denied). A malformed response is `bad_frame`; if its `requestId`
  can be recovered, the pending request is denied immediately so malformed
  `selectedHunks` can never widen a partial approval.
- `question.request` (ask_user tool) pauses the run until the matching
  `question.answer` arrives. The socket closing or 120 s without an answer
  resolve the question as `"(the user declined to answer)"`; an empty
  `answer` string counts as declined too. An unknown `id` →
  `{"type":"error","code":"unknown_request"}`.
- Model deltas stream as `{"type":"event", "event":{"type":"model.delta","chunk":"..."}}`
  — this is a server-level event type (the core emits deltas via callback);
  the final full text still arrives as the normal `model.message` event.
- Reasoning (chain-of-thought) deltas stream the same way as
  `{"type":"event", "event":{"type":"reasoning.delta","chunk":"..."}}` when the
  configured model runs in thinking mode (`thinking` / `reasoningEffort`
  config). Reasoning text is display-only and not persisted in transcripts.
- `command.output` AgentEvents (`{"type":"command.output","stream":"stdout"|"stderr","chunk":"..."}`)
  forward unchanged: live output of a running command (capped by the core; the
  full truncated output still lands in the tool result).
- `context.microcompacted` AgentEvents (`{"type":"context.microcompacted","clearedResults":n}`)
  forward unchanged: old tool outputs were blanked to save context.
- Socket close while running → the run is cancelled (AbortController).
- Socket close or parent completion cancels remaining child dispatches and clears
  their steering queues/listeners.

## Implementation notes (binding)

- Implementation lives in `apps/server` (package `@seekforge/server`),
  exporting `startServer(opts: {workspaces?: string[], workspace?: string, port?, token?}): Promise<{port, token, close()}>`
  so the CLI (`seekforge serve`) and later the Tauri shell can embed it.
  Provide `workspaces` (one or more; first is the default) or the single
  `workspace` shorthand (back-compat). `port: 0` binds an ephemeral port (the
  real one is reported back). Two additional optional opts exist for
  tests/embedding: `createAgent` (agent-assembly override) and `staticDir`
  (UI root override).
- Dependencies: `ws` only (plus workspace packages). No express.
- The server constructs AgentCore exactly like the CLI does (provider from
  config, default dispatcher, runtime when configured, extractMemory for
  edit mode, commandAllowlist from config), plus the TUI's config
  passthrough: `sandbox` and `compaction` into createAgentCore, `thinking`
  and `reasoningEffort` into the provider.

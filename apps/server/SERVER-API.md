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

## REST (all JSON; prefix /api)

All workspace-scoped routes below take an optional `?ws=<id>` (default: first
workspace). `GET /api/health` and `GET /api/workspaces` are global.

| Method/Path | Response |
| --- | --- |
| GET /api/health | `{version, workspace, workspaces: [{id, name, path}]}` (global; `workspace` = default path) |
| GET /api/workspaces | `[{id, name, path}]` (global; ordered, first is the default; includes registered worktrees `wt-<slug>`) |
| POST /api/worktrees | body `{name?}` → `{id, path, branch}` — create a worktree session (see "Worktrees"); 400 `not_a_git_repo` |
| GET /api/worktrees | `[{id, branch, path, dirty, ahead}]` — worktrees of the `?ws=` base workspace |
| POST /api/worktrees/:id/merge | `{merged: true}` \| `{conflict: true, files}` — dirty worktree auto-committed; conflicts abort cleanly |
| DELETE /api/worktrees/:id | `{deleted: true}` — remove worktree + branch, unregister the workspace |
| GET /api/project | `{path, name, detect: {languages, packageManager, frameworks, scripts}}` |
| GET /api/sessions | `SessionMeta[]` (newest first, subagent sessions hidden) |
| GET /api/diff[?staged=1] | `{diff, truncated}` — workspace `git diff` (2 MB cap) |
| GET /api/files[?q=] | `{files: string[], truncated}` — workspace-relative paths (BFS, shallow first; skips the tools' DEFAULT_IGNORE_DIRS, dot-directories, and symlinks; capped at 2000, `truncated: true` when the cap cut the scan short). `q` is a case-insensitive substring filter on the relative path, applied while scanning. Feeds the web composer's `@` file picker. |
| POST /api/upload | body `{name, dataBase64}` — saves a pasted/dropped image to `.seekforge/uploads/img-<stamp>.<ext>` and returns `{path}` (workspace-relative; core `image_analyze` consumes it). Only the extension of `name` is used (png/jpg/jpeg/gif/webp); decoded size capped at 4 MB; `dataBase64` may carry a data-URL prefix. Errors: 400 `bad_request` (bad JSON/fields/extension/base64), 413 `too_large`. |
| GET /api/sessions/:id | `{meta: SessionMeta, messages: ChatMessage[]}` |
| GET /api/sessions/:id/turns | `[{turn, text, backtrackable}]` — every `role:"user"` message of messages.jsonl in file order, numbered 0..N-1 (the same all-user-messages indexing the core's truncateSessionAtUserTurn / rewindSessionToTurn use). Turn 0 (the original task) has `backtrackable: false`; `[]` when no messages.jsonl exists yet; 404 unknown session |
| POST /api/sessions/:id/backtrack | body `{turn: integer, files?: boolean}` — truncates the conversation to just before user turn `turn` (truncateSessionAtUserTurn) and, when `files` is true, restores the file checkpoints of turns >= `turn` (rewindSessionToTurn). Returns `{removedMessages, keptMessages, files}` where `files` is `{restored, deleted, skipped}` counts, or `null` when file restore was not requested. 400 when `turn` is 0 or out of range, 404 unknown session |
| GET /api/todos | `[{index, text, done}]` — checklist lines of `.seekforge/todos.md` (same format contract as the TUI; 1-based indices count checklist lines only) |
| POST /api/todos | body `{op: "add", text}` \| `{op: "toggle"\|"remove", index}` — mutates `.seekforge/todos.md`, preserving every non-checklist line (headings/prose) verbatim; returns the updated todo list. 400 bad op/args, 404 index out of range |
| GET /api/balance | `{balance: {currency, totalBalance} \| null}` — DeepSeek account balance fetched with the server's key. Null-safe: missing key or any fetch failure returns `{balance: null}`, never an error |
| GET /api/mcp/resources | `{resources: [{server, uri, name?}]}` — resources/list of every configured MCP server (spawned on demand with the workspace advertised as a filesystem root, then disposed). A server that fails or lacks resource support contributes zero entries |
| GET /api/mcp/prompts | `{prompts: [{server, name, description?, arguments?}]}` — prompts/list of every configured MCP server (spawned on demand with the workspace advertised as a filesystem root, then disposed). A server that fails or lacks prompt support contributes zero entries. Mirrors GET /api/mcp/resources |
| GET /api/skills | `Skill[]` (without `content`) |
| GET /api/skills/:id | full `Skill` |
| GET /api/memory | `{projectMd: string \| null, candidates: MemoryCandidate[]}` |
| POST /api/memory/:id/approve | updated `MemoryCandidate` |
| POST /api/memory/:id/reject | updated `MemoryCandidate` |
| GET /api/config | config with `apiKey` masked (`sk-xxx****`), plus `{model, baseUrl, runtimeBin, commandAllowlist}` and the engine knobs `{sandbox, compaction, thinking, reasoningEffort}` (always present, with effective defaults `"off"` / `"mechanical"` / `false` / `null`); `mcpServers` is omitted (env values may be secret — see GET /api/mcp) |
| GET /api/agents | `AgentDefinition[]` without prompt bodies (id, name, scope, mode, model?, tools?, description, triggers, ...) |
| GET /api/agents/:id | full definition incl. prompt body (404 unknown) |
| GET /api/evolution | `EvolutionProposal[]` (pending first, newest first within each group) |
| POST /api/evolution/:id/accept\|reject\|apply | updated proposal (apply returns `{proposal, changedPath}`); 404 unknown id, 409 on wrong-state transitions and apply failures (e.g. skill_exists) |
| GET /api/mcp | configured servers `{name, command, args, trusted, envKeys}[]` (no spawn; env key names only, values never exposed) |
| POST /api/mcp/:name/tools | spawns the server, lists tools `{tools: {name, description}[]}`, disposes; 404 unconfigured, 502 `{error:{code:"mcp_error"}}` on launch/handshake failure |
| POST /api/rewind | body `{sessionId, dryRun?}` → rewindSession result; 404 on unknown session or zero checkpoints |
| PUT /api/config | body `{key, value, global?}` — same keys/validation as `seekforge config set`; 400 on unknown key |

Errors: `{error: {code, message}}` with appropriate HTTP status.

## WebSocket (path /ws?token=...)

One WS connection drives at most one *running* session at a time.
All frames are JSON objects with a `type` field.

### client → server

```jsonc
{"type": "start",  "task": "...", "mode": "edit"|"ask", "approvalMode": "auto"|"confirm", "plan": true?, "ws": "<id>"?,
                   "model": "deepseek-v4-pro"?, "thinking": true?, "reasoningEffort": "high"|"max"?}
{"type": "send",   "sessionId": "...", "task": "...", "mode": "edit"?, "ws": "<id>"?,   // continue; mode overrides
                   "model": "..."?, "thinking": true?, "reasoningEffort": "high"|"max"?} // the session's own (plan -> execute)
{"type": "permission.response", "requestId": "p1", "approved": true}
{"type": "question.answer", "id": "q1", "answer": "Option A"} // answer a pending question.request
{"type": "cancel"}                                            // cancel the running session
```

`model` / `thinking` / `reasoningEffort` are optional per-run overrides on
both `start` and `send`: when present they win over the workspace config for
THAT run only (a fresh agent/provider is assembled per run; nothing is written
to config). Omitted fields fall back to config. Invalid values (empty model,
non-boolean thinking, an effort other than `"high"`/`"max"`) →
`{"type":"error","code":"bad_frame"}`.

`ws` selects the workspace id (default: first workspace when omitted). The run
executes in that workspace's path; `send` looks the session up in that
workspace. An unknown `ws` id → `{"type":"error","code":"unknown_workspace"}`.

### server → client

```jsonc
{"type": "event", "sessionId": "...", "event": <AgentEvent>}  // every AgentEvent, incl. session.completed/failed
{"type": "permission.request", "requestId": "p1", "request": <PermissionRequest>}
{"type": "question.request", "id": "q1", "question": "...", "options": ["...", "..."]}  // ask_user tool
{"type": "error", "code": "...", "message": "..."}            // protocol-level errors (bad frame, busy, ...)
{"type": "idle"}                                              // sent when a run finishes and a new start/send is accepted
```

Rules:
- `start`/`send` while a run is active → `{"type":"error","code":"busy"}`.
- `send` resumes the session with its original ask/edit mode and
  `approvalMode: "confirm"`; an unknown session id →
  `{"type":"error","code":"unknown_session"}`.
- `permission.request` pauses the run until the matching `permission.response`
  arrives (or the socket closes, or 120 s pass without a response — both
  treated as denied).
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

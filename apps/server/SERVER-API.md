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
| GET /api/workspaces | `[{id, name, path}]` (global; ordered, first is the default) |
| GET /api/project | `{path, name, detect: {languages, packageManager, frameworks, scripts}}` |
| GET /api/sessions | `SessionMeta[]` (newest first, subagent sessions hidden) |
| GET /api/diff[?staged=1] | `{diff, truncated}` — workspace `git diff` (2 MB cap) |
| GET /api/sessions/:id | `{meta: SessionMeta, messages: ChatMessage[]}` |
| GET /api/skills | `Skill[]` (without `content`) |
| GET /api/skills/:id | full `Skill` |
| GET /api/memory | `{projectMd: string \| null, candidates: MemoryCandidate[]}` |
| POST /api/memory/:id/approve | updated `MemoryCandidate` |
| POST /api/memory/:id/reject | updated `MemoryCandidate` |
| GET /api/config | config with `apiKey` masked (`sk-xxx****`), plus `{model, baseUrl, runtimeBin, commandAllowlist}`; `mcpServers` is omitted (env values may be secret — see GET /api/mcp) |
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
{"type": "start",  "task": "...", "mode": "edit"|"ask", "approvalMode": "auto"|"confirm", "plan": true?, "ws": "<id>"?}
{"type": "send",   "sessionId": "...", "task": "...", "mode": "edit"?, "ws": "<id>"?}  // continue; mode overrides
                                                                        // the session's own (plan -> execute)
{"type": "permission.response", "requestId": "p1", "approved": true}
{"type": "question.answer", "id": "q1", "answer": "Option A"} // answer a pending question.request
{"type": "cancel"}                                            // cancel the running session
```

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

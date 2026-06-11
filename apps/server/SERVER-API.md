# seekforge serve — Local Agent Server API

Started with `seekforge serve [--port 7373]` inside a project directory.
Serves exactly one workspace (the cwd at start).

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

| Method/Path | Response |
| --- | --- |
| GET /api/health | `{version, workspace}` |
| GET /api/project | `{path, name, detect: {languages, packageManager, frameworks, scripts}}` |
| GET /api/sessions | `SessionMeta[]` (newest first) |
| GET /api/sessions/:id | `{meta: SessionMeta, messages: ChatMessage[]}` |
| GET /api/skills | `Skill[]` (without `content`) |
| GET /api/skills/:id | full `Skill` |
| GET /api/memory | `{projectMd: string \| null, candidates: MemoryCandidate[]}` |
| POST /api/memory/:id/approve | updated `MemoryCandidate` |
| POST /api/memory/:id/reject | updated `MemoryCandidate` |
| GET /api/config | config with `apiKey` masked (`sk-xxx****`), plus `{model, baseUrl, runtimeBin, commandAllowlist}` |
| PUT /api/config | body `{key, value, global?}` — same keys/validation as `seekforge config set`; 400 on unknown key |

Errors: `{error: {code, message}}` with appropriate HTTP status.

## WebSocket (path /ws?token=...)

One WS connection drives at most one *running* session at a time.
All frames are JSON objects with a `type` field.

### client → server

```jsonc
{"type": "start",  "task": "...", "mode": "edit"|"ask", "approvalMode": "auto"|"confirm"}
{"type": "send",   "sessionId": "...", "task": "..."}        // continue (resume) a session
{"type": "permission.response", "requestId": "p1", "approved": true}
{"type": "cancel"}                                            // cancel the running session
```

### server → client

```jsonc
{"type": "event", "sessionId": "...", "event": <AgentEvent>}  // every AgentEvent, incl. session.completed/failed
{"type": "permission.request", "requestId": "p1", "request": <PermissionRequest>}
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
- Model deltas stream as `{"type":"event", "event":{"type":"model.delta","chunk":"..."}}`
  — this is a server-level event type (the core emits deltas via callback);
  the final full text still arrives as the normal `model.message` event.
- Socket close while running → the run is cancelled (AbortController).

## Implementation notes (binding)

- Implementation lives in `apps/server` (package `@seekforge/server`),
  exporting `startServer(opts: {workspace, port?, token?}): Promise<{port, token, close()}>`
  so the CLI (`seekforge serve`) and later the Tauri shell can embed it.
  `port: 0` binds an ephemeral port (the real one is reported back).
  Two additional optional opts exist for tests/embedding: `createAgent`
  (agent-assembly override) and `staticDir` (UI root override).
- Dependencies: `ws` only (plus workspace packages). No express.
- The server constructs AgentCore exactly like the CLI does (provider from
  config, default dispatcher, runtime when configured, extractMemory for
  edit mode, commandAllowlist from config).

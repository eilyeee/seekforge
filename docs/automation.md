# Event-triggered automation (webhooks)

SeekForge's server can run a task when an **external event** arrives — a GitHub
push or pull request, a CI job finishing, any system that can send an HTTP POST.
This is the webhook counterpart to [scheduled jobs](scheduling.md): scheduling
fires on a clock, a *trigger* fires on an event.

A trigger is registered on the **server** (not the CLI scheduler) and lives in
the workspace at `.seekforge/triggers.json`. When its endpoint is called with
valid credentials, the server starts a **headless, cost-bounded** agent run of
the trigger's task and returns the new session id.

Every triggered run is a **normal, auditable session** — it writes the same
JSONL trace as an interactive run, so it shows up in `seekforge sessions`, can
be replayed with `seekforge replay <id>`, reviewed with `seekforge audit <id>`,
and undone with `seekforge rewind <id>`.

## Safety first

A webhook can be called by an external system with no human watching, so a
triggered run is locked down three ways:

1. **Dual authentication.** The server already gates *every* `/api` route behind
   its bearer token (127.0.0.1-bound, `Authorization: Bearer <token>` or
   `?token=`). The fire endpoint requires that **and** the trigger's own
   per-trigger `secret`, compared in constant time. This lets you hand a
   GitHub/CI webhook the trigger URL + secret without giving it the full server
   token — but for now the trigger is still behind the server token too (see
   [Exposing to the internet](#exposing-to-the-internet)). A wrong or missing
   secret is a `403`; a wrong or missing server token is a `401`.
2. **A cost budget is mandatory.** Every trigger requires `maxCostUsd`. The run
   aborts gracefully the moment cumulative spend reaches the budget (the trace
   is kept). A trigger with no budget is **rejected at creation** — there is no
   way to register an unbounded trigger.
3. **The run is headless.** A triggered run uses the same engine as an
   interactive run, but in a machine (non-interactive) mode: the agent's
   approval callback **auto-denies** anything that would normally prompt.
   Dangerous commands stay denied, and command execution / environment changes
   are refused (there is no human to approve them, and a triggered run must
   never hang waiting for input). An `edit` trigger runs in *acceptEdits* so
   ordinary in-workspace file edits apply autonomously; everything riskier is
   still refused.

## The trigger format

Triggers live in `.seekforge/triggers.json` (workspace-scoped, written
owner-only `0600` because it holds secrets). Each trigger is:

```jsonc
[
  {
    "id": "ci-review",             // stable id; also the URL segment
    "task": "Review the latest push and flag any regressions.",
    "mode": "edit",                // "ask" (read-only) or "edit" (may edit files)
    "maxCostUsd": 0.5,             // REQUIRED hard cost cap (USD)
    "secret": "a-long-random-shared-token", // REQUIRED; min 8 chars
    "enabled": true                // optional; defaults to true
  }
]
```

- `maxCostUsd` and `secret` are **required**; a trigger missing either is
  rejected.
- Do **not** hardcode a real secret in docs or commits — generate one (e.g.
  `openssl rand -hex 24`) and store it wherever your webhook config lives.

## Endpoints

All endpoints are under `/api` and require the server bearer token. Secrets are
**masked** (`"***"`) in every response.

| Method + path | Purpose |
| --- | --- |
| `GET /api/triggers` | List triggers (secrets masked). |
| `POST /api/triggers` | Create a trigger (rejects missing `maxCostUsd`/`secret`). Returns `201`. |
| `DELETE /api/triggers/:id` | Remove a trigger. |
| `POST /api/triggers/:id` | **Fire** the trigger — start a headless run. Returns `202`. |

The workspace is selected with `?ws=<id>` like every other scoped route
(defaulting to the first workspace).

### Firing a trigger

`POST /api/triggers/:id` needs **both** credentials:

- the server bearer token (`Authorization: Bearer <token>`), and
- the trigger secret, as the `x-seekforge-trigger-secret` header **or** a
  `?secret=` query parameter.

An optional JSON request body (e.g. a GitHub webhook payload) is distilled into
a short summary — action, repo, ref, PR/issue number + title, sender, head
commit — and appended to the task so the run has context. The body is bounded;
unknown shapes contribute only their top-level key names (no values).

On success the server answers `202 Accepted` with the new session id and returns
immediately; the run continues in the background:

```json
{ "sessionId": "20260703-...-ab12", "triggerId": "ci-review" }
```

Responses: `202` fired · `400` malformed body · `401` bad/missing server token ·
`403` bad/missing trigger secret · `404` unknown trigger · `409` trigger
disabled.

## Pointing a GitHub / CI webhook at it

1. Create the trigger:

   ```bash
   curl -sS -X POST "http://127.0.0.1:7373/api/triggers" \
     -H "Authorization: Bearer $SEEKFORGE_TOKEN" \
     -H "content-type: application/json" \
     -d '{"id":"ci-review","task":"Review the latest push.","mode":"ask","maxCostUsd":0.5,"secret":"'"$TRIGGER_SECRET"'"}'
   ```

2. Point the webhook at the fire URL, carrying both credentials. For a GitHub
   webhook you control the headers via the delivery, so send the server token as
   the `Authorization` header and the trigger secret as
   `x-seekforge-trigger-secret` (GitHub's own HMAC `secret` field is separate and
   not used here). A generic CI job can simply `curl`:

   ```bash
   curl -X POST "http://127.0.0.1:7373/api/triggers/ci-review" \
     -H "Authorization: Bearer $SEEKFORGE_TOKEN" \
     -H "x-seekforge-trigger-secret: $TRIGGER_SECRET" \
     -H "content-type: application/json" \
     --data-binary @event.json
   ```

## Exposing to the internet

The server binds `127.0.0.1` only and requires its bearer token, so a trigger is
not directly reachable from the public internet by design. To receive real
GitHub/CI webhooks, front the server with something you control — a reverse
proxy or an authenticated tunnel — and forward the two credentials through it.
The per-trigger secret means a single leaked trigger URL still can't fire a run
without the secret, and can't touch any other endpoint. Rotate a secret by
`DELETE`-ing and re-creating the trigger (or editing `triggers.json` and
restarting).

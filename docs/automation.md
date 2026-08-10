# Event-triggered automation (webhooks)

> **English** | [简体中文](automation.zh-CN.md)

SeekForge's server can run a task when an **external event** arrives — a GitHub
push or pull request, a CI job finishing, any system that can send an HTTP POST.
This is the webhook counterpart to [scheduled jobs](scheduling.md): scheduling
fires on a clock, a *trigger* fires on an event.

A trigger is registered on the **server** (not the CLI scheduler) and lives in
the workspace at `.seekforge/triggers.json`. When its endpoint is called with
valid credentials, the server starts a **headless, cost-bounded** agent run of
the trigger's task and returns the new session id.

Every triggered run is a **normal, auditable session** — it writes the same
JSONL trace as an interactive run, so it can be replayed with `seekforge replay
<id>`, reviewed with `seekforge audit <id>`, and undone with `seekforge rewind
<id>`.

Where that trace lives depends on isolation. An `ask` trigger (and any trigger
pinned to `isolation: "workspace"`) writes into the workspace, so it appears in
`seekforge sessions` there. An `edit` trigger normally runs in its own git
worktree (see guardrail 4 below) and **writes its session trace inside that
worktree** — `seekforge sessions` run from the base repository will not list it.
The run ledger stays in the base workspace either way: `GET /api/runs` (or
`.seekforge/runs.jsonl`) gives you the `runId`, the `sessionId`, and the
`worktreeId`/`worktreeBranch` labels; `cd` into that worktree to run
`seekforge sessions` / `audit` / `replay` against the trace.

## Safety first

A webhook can be called by an external system with no human watching, so a
triggered run is locked down four ways:

1. **Authenticated delivery.** A generic caller uses the server bearer token
   plus the trigger's per-trigger secret. A native GitHub webhook instead signs
   the exact request body with that trigger secret and sends
   `X-Hub-Signature-256`; it does not need to invent custom GitHub headers or
   expose the server bearer token. Secret comparisons are constant-time.
2. **Every run is bounded — by cost where possible, by tokens always.** Every
   trigger requires `maxCostUsd`; one without it is **rejected at creation**.
   The run aborts gracefully the moment cumulative spend reaches the budget (the
   trace is kept). But that budget is a no-op on a provider with no price table:
   costs are reported as 0, so it can never be reached. The guarantee that holds
   regardless of pricing is a hard ceiling of **8,000,000 cumulative tokens**
   (prompt + completion) per triggered run, after which the run is aborted the
   same graceful way. Set `modelPricing` in config if you want the dollar figure
   you asked for to be the binding one.
3. **The run is headless.** A triggered run uses the same engine as an
   interactive run, but in a machine (non-interactive) mode: the agent's
   approval callback **auto-denies** anything that would normally prompt.
   Dangerous commands stay denied, and command execution / environment changes
   are refused (there is no human to approve them, and a triggered run must
   never hang waiting for input). An `edit` trigger runs in *acceptEdits* so
   ordinary in-workspace file edits apply autonomously; everything riskier is
   still refused. An `ask` trigger is not widened at all — it is read-only and
   every confirmation is denied.
4. **Writable runs are isolated.** An `edit` trigger defaults to
   `isolation: "auto"`: in a git repository SeekForge creates a dedicated
   worktree/branch and records its id in the run labels for later review and
   merge. A non-git workspace falls back to serialized workspace execution.
   Set `"workspace"` explicitly to opt out or `"worktree"` to require
   isolation and fail if it cannot be created.

## The trigger format

Triggers live in `.seekforge/triggers.json` (workspace-scoped, written
owner-only `0600` because it holds secrets). Each trigger is:

```jsonc
[
  {
    "id": "ci-review",             // stable id; also the URL segment
    "task": "Review the latest push and flag any regressions.",
    "mode": "edit",                // "ask" (read-only) or "edit" (may edit files)
    "isolation": "auto",           // optional: auto | workspace | worktree
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

Management endpoints are under `/api` and require the server bearer token.
Secrets are **masked** (`"***"`) in every response. The fire route also accepts
a correctly signed native GitHub delivery without the bearer token; this is the
only authentication exception.

| Method + path | Purpose |
| --- | --- |
| `GET /api/triggers` | List triggers (secrets masked). |
| `POST /api/triggers` | Create a trigger (rejects missing `maxCostUsd`/`secret` with `400`; an id that already exists with `409`). Returns `201`. |
| `DELETE /api/triggers/:id` | Remove a trigger. |
| `POST /api/triggers/:id` | **Fire** the trigger — start a headless run. Returns `202`. |

The workspace is selected with `?ws=<id>` like every other scoped route
(defaulting to the first workspace).

### Firing a trigger

For a generic CI or service caller, `POST /api/triggers/:id` needs **both**:

- the server bearer token (`Authorization: Bearer <token>`), and
- the trigger secret, as the `x-seekforge-trigger-secret` header **or** a
  `?secret=` query parameter.

For a native GitHub webhook, configure the trigger's `secret` as GitHub's
webhook secret. GitHub sends:

- `X-Hub-Signature-256: sha256=<HMAC>` over the exact request bytes,
- `X-GitHub-Delivery: <unique-delivery-id>`, and
- `X-GitHub-Event: <event-name>`.

Signed GitHub requests do not require the server bearer token or
`x-seekforge-trigger-secret`. Accepted events are `push`, `pull_request`,
`issues`, `issue_comment`, and `workflow_run`. Deliveries are deduplicated by
workspace, trigger, and delivery ID for 24 hours; a duplicate returns `409`.
The persisted claim is protected by a cross-process workspace lease, so two
Server instances sharing one workspace cannot both accept the same delivery.

The delivery store also has a hard cap of **10,000 remembered deliveries per
workspace**; past it the soonest-to-expire entries are dropped first. Under
sustained high webhook volume a delivery id can therefore be forgotten before
its 24 hours are up, and a redelivery of it would fire the run again. Dedup is
a duplicate-suppression best effort, not a transactional exactly-once promise.

An optional JSON request body (e.g. a GitHub webhook payload) is distilled into
a short summary — action, repo, ref, PR/issue number + title, sender, head
commit — and appended to the task so the run has context. The request body is
capped at 25 MiB (GitHub's own webhook limit); a larger one is rejected with
`413`. The summary appended to the task is bounded far more tightly, and unknown
shapes contribute only their top-level key names (no values).

On success the server answers `202 Accepted` with the new run id and session id
and returns immediately; the run continues in the background:

```json
{ "runId": "run-lz4k9x-3f8a1c2b5d6e", "sessionId": "20260703-...-ab12", "triggerId": "ci-review" }
```

`runId` is the key that locates this run in the ledger (`GET /api/runs/:id`,
`.seekforge/runs.jsonl`) — including its final status, cost, and the isolation
labels you need to find the trace of a worktree-isolated run.

Responses: `202` fired · `400` malformed body or invalid GitHub event metadata ·
`401` bad/missing server token for a generic request · `403` bad trigger secret
or GitHub signature · `404` unknown trigger · `409` trigger disabled or duplicate
GitHub delivery · `413` request body over 25 MiB · `500` the run could not be
started (a claimed GitHub delivery id is released again so a redelivery can
retry).

Note that a request carrying GitHub-shaped headers (`X-Hub-Signature-256` or
`X-GitHub-Delivery`) never gets `404`: an unknown trigger id answers `403`, the
same as a bad signature, so an unauthenticated caller cannot probe which trigger
ids exist.

## Pointing a GitHub / CI webhook at it

1. Create the trigger:

   ```bash
   curl -sS -X POST "http://127.0.0.1:7373/api/triggers" \
     -H "Authorization: Bearer $SEEKFORGE_TOKEN" \
     -H "content-type: application/json" \
     -d '{"id":"ci-review","task":"Review the latest push.","mode":"ask","maxCostUsd":0.5,"secret":"'"$TRIGGER_SECRET"'"}'
   ```

2. For GitHub, set the payload URL to the fire endpoint, choose JSON content,
   and enter the same value as the trigger's `secret` in GitHub's **Secret**
   field. Select only supported events. SeekForge verifies GitHub's native
   `X-Hub-Signature-256`, requires its delivery/event headers, and rejects
   duplicate deliveries. No custom `Authorization` or
   `x-seekforge-trigger-secret` header is needed.

3. A generic CI job retains the dual-secret mode and can simply `curl`:

   ```bash
   curl -X POST "http://127.0.0.1:7373/api/triggers/ci-review" \
     -H "Authorization: Bearer $SEEKFORGE_TOKEN" \
     -H "x-seekforge-trigger-secret: $TRIGGER_SECRET" \
     -H "content-type: application/json" \
     --data-binary @event.json
   ```

   **Do not send GitHub's headers on a generic call.** As soon as a request
   carries `X-Hub-Signature-256` *or* `X-GitHub-Delivery`, it is treated as a
   native GitHub delivery and must carry a valid `X-Hub-Signature-256` over the
   exact body — a correct bearer token and trigger secret will not rescue it,
   and the answer is `403`. This bites relay/proxy setups that forward
   `X-GitHub-Delivery` while re-signing or dropping the signature: forward
   **both** headers unchanged, or **neither**.

## Exposing to the internet

The server binds `127.0.0.1` only, so a trigger is not directly reachable from
the public internet by design. To receive real GitHub/CI webhooks, front it with
a reverse proxy or tunnel you control. Forward GitHub's signature, delivery,
event, and content-type headers without rewriting the body; HMAC verification
depends on the exact bytes. Generic callers must also forward the bearer and
trigger-secret headers — and must not have GitHub's signature or delivery header
added to their requests, which would put them on the signature-only path. The
per-trigger secret means a leaked URL alone cannot fire a run or access
management endpoints. Rotate a secret by `DELETE`-ing and re-creating the
trigger (or editing `triggers.json` and restarting).

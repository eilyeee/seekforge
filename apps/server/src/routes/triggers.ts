/**
 * Event-triggered automation (webhook triggers) — see docs/automation.md.
 * Every /api route is already behind the server bearer token; the fire
 * endpoint below ALSO requires the per-trigger secret (dual auth). Secrets
 * are masked in every response.
 */

import { readProjectFile, writeProjectFileAtomic } from "../config.js";
import { isBodyTooLarge, readBody, readJsonBody, sendApiError, sendJson } from "../http.js";
import { startManagedTriggerRun } from "../trigger-run.js";
import {
  addTrigger,
  buildTriggerTask,
  checkGitHubSignature,
  checkTriggerSecret,
  getTrigger,
  loadTriggers,
  maskTrigger,
  removeTrigger,
  validateTrigger,
} from "../triggers.js";
import type { RouteCtx } from "./context.js";

const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN_DELIVERIES = 10_000;
const GITHUB_EVENTS = new Set(["push", "pull_request", "issues", "issue_comment", "workflow_run"]);
// Delivery-id dedup is PERSISTED per workspace (not just in memory) so a server
// restart, a second instance, or eviction can't let an already-processed GitHub
// delivery fire a second cost-bounded run. Entries are evicted by EXPIRY (TTL),
// with a large hard cap as a safety valve that drops the soonest-to-expire first.
const DELIVERY_FILE = ".seekforge/trigger-deliveries.json";

/** deliveryKey → epoch-ms expiry. Only unexpired entries survive a load. */
type DeliveryStore = Record<string, number>;

/** Load the persisted delivery store, dropping any entry past its TTL. */
function loadDeliveries(workspace: string): DeliveryStore {
  let parsed: unknown;
  try {
    const raw = readProjectFile(workspace, DELIVERY_FILE);
    if (raw === undefined) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const now = Date.now();
  const out: DeliveryStore = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > now) out[key] = value;
  }
  return out;
}

/** Persist the delivery store atomically (owner-only). */
function saveDeliveries(workspace: string, store: DeliveryStore): void {
  writeProjectFileAtomic(workspace, DELIVERY_FILE, `${JSON.stringify(store)}\n`);
}

/** Safety valve: keep the store bounded by dropping the soonest-to-expire keys. */
function capDeliveries(store: DeliveryStore): void {
  const keys = Object.keys(store);
  if (keys.length <= MAX_SEEN_DELIVERIES) return;
  keys.sort((a, b) => store[a]! - store[b]!);
  for (const key of keys.slice(0, keys.length - MAX_SEEN_DELIVERIES)) delete store[key];
}
const UNKNOWN_TRIGGER_SECRET = "seekforge-unknown-trigger-secret";
// GitHub caps webhook payloads at 25 MB; a large push / PR / many-commit
// delivery routinely exceeds readBody's default 1 MB cap. The whole body must
// be read (for HMAC verification) before it can be accepted, so raise the cap
// for THIS route only — other routes keep their tighter defaults.
const MAX_TRIGGER_BODY_BYTES = 26_214_400; // 25 MiB

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, workspace, rest }: RouteCtx): Promise<void> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/triggers") {
    return sendJson(res, 200, loadTriggers(workspace).map(maskTrigger));
  }

  // Create a trigger. Rejects one with no maxCostUsd or no secret.
  if (method === "POST" && path === "/api/triggers") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const result = validateTrigger(body);
    if ("error" in result) return sendApiError(res, 400, "bad_request", result.error);
    const added = addTrigger(workspace, result.trigger);
    if ("error" in added) return sendApiError(res, 409, "conflict", added.error);
    return sendJson(res, 201, maskTrigger(added.trigger));
  }

  if (method === "DELETE" && segs.length === 3 && segs[1] === "triggers") {
    const removed = removeTrigger(workspace, segs[2]!);
    if (!removed) return sendApiError(res, 404, "not_found", `trigger not found: ${segs[2]}`);
    return sendJson(res, 200, { deleted: true });
  }

  // Fire a trigger: start a HEADLESS, cost-bounded run of its task and answer
  // 202 with the new (auditable) session id. Dual auth — the server bearer
  // token (already checked) AND the trigger's own secret, constant-time
  // compared. An optional JSON body (e.g. a GitHub webhook payload) is
  // distilled into a short summary appended to the task.
  if (method === "POST" && segs.length === 3 && segs[1] === "triggers") {
    const id = segs[2]!;
    const trigger = getTrigger(workspace, id);
    // Bespoke body read: an empty body must stay `undefined` (no payload
    // summary appended to the task), not readJsonBody's emptyOk `{}` — and
    // this route's parse-error message mentions the body being optional.
    let rawPayload: string;
    try {
      rawPayload = await readBody(req, MAX_TRIGGER_BODY_BYTES);
    } catch (err) {
      if (isBodyTooLarge(err)) return sendApiError(res, 413, "too_large", "request body too large");
      throw err;
    }
    const signature = req.headers["x-hub-signature-256"];
    const githubDelivery = req.headers["x-github-delivery"];
    const githubEvent = req.headers["x-github-event"];
    const githubRequest = typeof signature === "string" || typeof githubDelivery === "string";
    const githubSigned = checkGitHubSignature(trigger?.secret ?? UNKNOWN_TRIGGER_SECRET, rawPayload, signature);
    const header = req.headers["x-seekforge-trigger-secret"];
    const presented = (typeof header === "string" ? header : undefined) ?? url.searchParams.get("secret");
    if (githubRequest && (!trigger || !githubSigned)) {
      return sendApiError(res, 403, "forbidden", "invalid trigger secret or GitHub signature");
    }
    if (!trigger) return sendApiError(res, 404, "not_found", `trigger not found: ${id}`);
    if (!githubSigned && !checkTriggerSecret(trigger.secret, presented)) {
      return sendApiError(res, 403, "forbidden", "invalid trigger secret or GitHub signature");
    }
    if (!trigger.enabled) {
      return sendApiError(res, 409, "conflict", `trigger is disabled: ${id}`);
    }
    let deliveryKey: string | undefined;
    let deliveries: DeliveryStore | undefined;
    if (githubSigned) {
      if (typeof githubDelivery !== "string" || githubDelivery.length === 0) {
        return sendApiError(res, 400, "bad_request", "missing x-github-delivery");
      }
      if (typeof githubEvent !== "string" || !GITHUB_EVENTS.has(githubEvent)) {
        return sendApiError(res, 400, "bad_request", "unsupported x-github-event");
      }
      // Load-check-then-set runs entirely synchronously (no await between here
      // and the set below), so two concurrent deliveries of the same id cannot
      // both pass the check — the first completes its save before the event loop
      // yields at the run's `await`. loadDeliveries already evicted expired ids.
      deliveries = loadDeliveries(workspace);
      deliveryKey = `${id}\0${githubDelivery}`;
      if (deliveryKey in deliveries) {
        return sendApiError(res, 409, "conflict", "duplicate GitHub delivery");
      }
    }
    let payload: unknown;
    try {
      payload = rawPayload.trim() === "" ? undefined : JSON.parse(rawPayload);
    } catch {
      return sendApiError(res, 400, "bad_request", "body must be valid JSON when present");
    }
    const task = buildTriggerTask(trigger.task, payload);
    if (deliveryKey !== undefined && deliveries !== undefined) {
      deliveries[deliveryKey] = Date.now() + DELIVERY_TTL_MS;
      capDeliveries(deliveries);
      saveDeliveries(workspace, deliveries);
    }
    try {
      const ledgerRun = rest.runManager.create({
        workspace,
        source: "trigger",
        labels: { triggerId: id },
      });
      const run = startManagedTriggerRun({
        createAgent: rest.createAgent,
        workspace,
        task,
        mode: trigger.mode,
        maxCostUsd: trigger.maxCostUsd,
        runManager: rest.runManager,
        runId: ledgerRun.runId,
      });
      rest.triggerRuns?.add(run);
      void run.completion.then(
        () => rest.triggerRuns?.delete(run),
        () => rest.triggerRuns?.delete(run),
      );
      const { sessionId } = await run.started;
      return sendJson(res, 202, { runId: ledgerRun.runId, sessionId, triggerId: id });
    } catch (err) {
      // Free the delivery id so the webhook can be retried. Reload first: a
      // concurrent delivery may have persisted its own key while this run was
      // starting, and we must not clobber it with our stale snapshot.
      if (deliveryKey !== undefined) {
        const fresh = loadDeliveries(workspace);
        delete fresh[deliveryKey];
        saveDeliveries(workspace, fresh);
      }
      return sendApiError(res, 500, "internal", err instanceof Error ? err.message : String(err));
    }
  }
}

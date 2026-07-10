/**
 * Event-triggered automation (webhook triggers) — see docs/automation.md.
 * Every /api route is already behind the server bearer token; the fire
 * endpoint below ALSO requires the per-trigger secret (dual auth). Secrets
 * are masked in every response.
 */

import { isBodyTooLarge, readBody, readJsonBody, sendApiError, sendJson } from "../http.js";
import { startTriggerRun } from "../trigger-run.js";
import {
  addTrigger,
  buildTriggerTask,
  checkTriggerSecret,
  getTrigger,
  loadTriggers,
  maskTrigger,
  removeTrigger,
  validateTrigger,
} from "../triggers.js";
import type { RouteCtx } from "./context.js";

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
    if (!trigger) return sendApiError(res, 404, "not_found", `trigger not found: ${id}`);
    const header = req.headers["x-seekforge-trigger-secret"];
    const presented =
      (typeof header === "string" ? header : undefined) ?? url.searchParams.get("secret");
    if (!checkTriggerSecret(trigger.secret, presented)) {
      return sendApiError(res, 403, "forbidden", "invalid or missing trigger secret");
    }
    if (!trigger.enabled) {
      return sendApiError(res, 409, "conflict", `trigger is disabled: ${id}`);
    }
    // Bespoke body read: an empty body must stay `undefined` (no payload
    // summary appended to the task), not readJsonBody's emptyOk `{}` — and
    // this route's parse-error message mentions the body being optional.
    let rawPayload: string;
    try {
      rawPayload = await readBody(req);
    } catch (err) {
      if (isBodyTooLarge(err)) return sendApiError(res, 413, "too_large", "request body too large");
      throw err;
    }
    let payload: unknown;
    try {
      payload = rawPayload.trim() === "" ? undefined : JSON.parse(rawPayload);
    } catch {
      return sendApiError(res, 400, "bad_request", "body must be valid JSON when present");
    }
    const task = buildTriggerTask(trigger.task, payload);
    try {
      const { sessionId } = await startTriggerRun({
        createAgent: rest.createAgent,
        workspace,
        task,
        mode: trigger.mode,
        maxCostUsd: trigger.maxCostUsd,
      });
      return sendJson(res, 202, { sessionId, triggerId: id });
    } catch (err) {
      return sendApiError(res, 500, "internal", err instanceof Error ? err.message : String(err));
    }
  }
}

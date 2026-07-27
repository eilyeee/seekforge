import {
  discoverLoopVerificationPlan,
  isRecord,
  isValidLoopId,
  listLoopStates,
  loadLoopState,
  pruneLoopStates,
  readLoopHistory,
  recoverInterruptedLoops,
  removeLoopState,
  setLoopPriority,
} from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, url, res, workspace } = ctx;
  if (segs[1] !== "loops") return false;

  if (method === "GET" && segs.length === 2) {
    sendJson(res, 200, listLoopStates(workspace));
    return true;
  }
  if (method === "GET" && segs[2] === "verification-plan" && segs.length === 3) {
    try {
      sendJson(res, 200, discoverLoopVerificationPlan(workspace));
    } catch (error) {
      sendApiError(res, 400, "not_found", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "POST" && segs[2] === "recover" && segs.length === 3) {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (!isRecord(body)) {
      sendApiError(res, 400, "bad_request", "body must be an object");
      return true;
    }
    const limit = body.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)) {
      sendApiError(res, 400, "bad_request", "limit must be an integer from 1 to 100");
      return true;
    }
    sendJson(res, 200, recoverInterruptedLoops(workspace, typeof limit === "number" ? { limit } : {}));
    return true;
  }
  if (method === "POST" && segs[2] === "prune" && segs.length === 3) {
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    if (!isRecord(body)) {
      sendApiError(res, 400, "bad_request", "body must be an object");
      return true;
    }
    const input = body;
    if (
      (input.maxAgeDays !== undefined &&
        (typeof input.maxAgeDays !== "number" || !Number.isFinite(input.maxAgeDays) || input.maxAgeDays < 0)) ||
      (input.maxTerminalCount !== undefined &&
        (!Number.isSafeInteger(input.maxTerminalCount) || (input.maxTerminalCount as number) < 0)) ||
      (input.dryRun !== undefined && typeof input.dryRun !== "boolean") ||
      (input.maxAgeDays === undefined && input.maxTerminalCount === undefined)
    ) {
      sendApiError(res, 400, "bad_request", "prune requires valid maxAgeDays or maxTerminalCount");
      return true;
    }
    try {
      sendJson(res, 200, pruneLoopStates(workspace, input as Parameters<typeof pruneLoopStates>[1]));
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  const loopId = segs[2];
  if (!loopId || !isValidLoopId(loopId)) {
    sendApiError(res, 400, "bad_request", "invalid loop id");
    return true;
  }
  if (method === "GET" && segs.length === 3) {
    const state = loadLoopState(workspace, loopId);
    if (!state) sendApiError(res, 404, "not_found", `unknown loop: ${loopId}`);
    else sendJson(res, 200, state);
    return true;
  }
  if (method === "GET" && segs[3] === "history" && segs.length === 4) {
    const after = boundedInteger(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(url.searchParams.get("limit"), 100, 1, 1_000);
    if (after === null || limit === null) {
      sendApiError(res, 400, "bad_request", "history after/limit are invalid");
    } else if (!loadLoopState(workspace, loopId)) {
      sendApiError(res, 404, "not_found", `unknown loop: ${loopId}`);
    } else {
      sendJson(res, 200, readLoopHistory(workspace, loopId, { afterSeq: after, limit }));
    }
    return true;
  }
  if (method === "POST" && segs[3] === "priority" && segs.length === 4) {
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    if (!isRecord(body)) {
      sendApiError(res, 400, "bad_request", "body must be an object");
      return true;
    }
    const priority = body.priority;
    if (!Number.isSafeInteger(priority) || (priority as number) < -10 || (priority as number) > 10) {
      sendApiError(res, 400, "bad_request", "priority must be an integer from -10 to 10");
    } else {
      try {
        sendJson(res, 200, setLoopPriority(workspace, loopId, priority as number));
      } catch (error) {
        sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
      }
    }
    return true;
  }
  if (method === "DELETE" && segs.length === 3) {
    try {
      if (!removeLoopState(workspace, loopId)) sendApiError(res, 404, "not_found", `unknown loop: ${loopId}`);
      else sendJson(res, 200, { removed: true, loopId });
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  return false;
}

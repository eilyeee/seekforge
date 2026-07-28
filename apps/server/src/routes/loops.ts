import {
  buildLoopEvidenceReport,
  archiveLoopDagResources,
  compareLoopEvidence,
  discoverLoopVerificationPlan,
  enqueueLoopControl,
  isRecord,
  isLoopLeaseActive,
  isValidLoopId,
  inspectLoopDagResources,
  listLoopDagStates,
  listLoopSpeculationStates,
  listLoopStates,
  loadLoopDagState,
  loadLoopSpeculationState,
  loadLoopState,
  pruneLoopStates,
  promoteLoopDagResult,
  promoteLoopSpeculation,
  pruneLoopDagResources,
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
  if (segs[1] === "loop-dags") {
    if (method === "GET" && segs.length === 2) {
      sendJson(res, 200, listLoopDagStates(workspace));
      return true;
    }
    const dagId = segs[2];
    if (method === "GET" && segs.length === 3 && dagId) {
      const state = loadLoopDagState(workspace, dagId);
      if (state) sendJson(res, 200, state);
      else sendApiError(res, 404, "not_found", `unknown Loop DAG: ${dagId}`);
      return true;
    }
    if (dagId && segs.length === 4 && segs[3] === "resources") {
      try {
        if (method === "GET") sendJson(res, 200, await inspectLoopDagResources(workspace, dagId));
        else if (method === "POST") {
          const body = await readJsonBody(ctx.req, res);
          if (body === undefined) return true;
          if (!isRecord(body)) sendApiError(res, 400, "bad_request", "body must be an object");
          else if (body.operation === "archive") sendJson(res, 200, archiveLoopDagResources(workspace, dagId));
          else if (body.operation === "prune") {
            if (
              (body.dryRun !== undefined && typeof body.dryRun !== "boolean") ||
              (body.force !== undefined && typeof body.force !== "boolean")
            ) {
              sendApiError(res, 400, "bad_request", "dryRun and force must be boolean");
            } else {
              sendJson(
                res,
                200,
                await pruneLoopDagResources(workspace, dagId, {
                  dryRun: body.dryRun as boolean | undefined,
                  force: body.force as boolean | undefined,
                }),
              );
            }
          } else if (body.operation === "promote" && typeof body.target === "string") {
            sendJson(res, 200, await promoteLoopDagResult(workspace, dagId, body.target));
          } else sendApiError(res, 400, "bad_request", "unknown Loop DAG resource operation");
        } else return false;
      } catch (error) {
        sendApiError(res, 409, "conflict", error instanceof Error ? error.message : String(error));
      }
      return true;
    }
    return false;
  }
  if (segs[1] === "loop-speculations") {
    if (method === "GET" && segs.length === 2) {
      sendJson(res, 200, listLoopSpeculationStates(workspace));
      return true;
    }
    const speculationId = segs[2];
    if (method === "GET" && segs.length === 3 && speculationId) {
      const state = loadLoopSpeculationState(workspace, speculationId);
      if (state) sendJson(res, 200, state);
      else sendApiError(res, 404, "not_found", `unknown Loop speculation: ${speculationId}`);
      return true;
    }
    if (method === "POST" && segs.length === 4 && segs[3] === "promote" && speculationId) {
      try {
        sendJson(res, 200, await promoteLoopSpeculation(workspace, speculationId));
      } catch (error) {
        sendApiError(res, 409, "conflict", error instanceof Error ? error.message : String(error));
      }
      return true;
    }
    return false;
  }
  if (segs[1] !== "loops") return false;

  if (method === "GET" && segs.length === 2) {
    const limit = boundedInteger(url.searchParams.get("limit"), 100, 1, 500);
    const after = url.searchParams.get("after");
    const status = url.searchParams.get("status");
    const query = url.searchParams.get("q")?.trim().toLowerCase();
    if (limit === null || (after !== null && !isValidLoopId(after))) {
      sendApiError(res, 400, "bad_request", "Loop list cursor or limit is invalid");
      return true;
    }
    const states = listLoopStates(workspace);
    const cursorIndex = after === null ? -1 : states.findIndex((state) => state.loopId === after);
    if (after !== null && cursorIndex < 0) {
      sendApiError(res, 400, "bad_request", "unknown Loop list cursor");
      return true;
    }
    const start = cursorIndex + 1;
    sendJson(
      res,
      200,
      states
        .slice(start)
        .filter((state) => !status || state.status === status)
        .filter(
          (state) => !query || state.loopId.toLowerCase().includes(query) || state.task.toLowerCase().includes(query),
        )
        .slice(0, limit),
    );
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
  if (method === "GET" && segs[3] === "evidence" && segs.length === 4) {
    const state = loadLoopState(workspace, loopId);
    if (!state) sendApiError(res, 404, "not_found", `unknown loop: ${loopId}`);
    else {
      const compareId = url.searchParams.get("compare");
      if (compareId !== null) {
        const other = isValidLoopId(compareId) ? loadLoopState(workspace, compareId) : null;
        if (!other) sendApiError(res, 404, "not_found", `unknown comparison Loop: ${compareId}`);
        else sendJson(res, 200, compareLoopEvidence(buildLoopEvidenceReport(state), buildLoopEvidenceReport(other)));
      } else sendJson(res, 200, buildLoopEvidenceReport(state));
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
  if (method === "POST" && segs[3] === "control" && segs.length === 4) {
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    const state = loadLoopState(workspace, loopId);
    if (
      !isRecord(body) ||
      (body.operation !== "pause" && body.operation !== "resume" && body.operation !== "steer") ||
      (body.operation === "steer" &&
        (typeof body.message !== "string" || body.message.trim() === "" || body.message.length > 8_192))
    ) {
      sendApiError(res, 400, "bad_request", "invalid Loop control command");
    } else if (
      !state ||
      (state.status !== "running" && state.status !== "paused") ||
      !state.controlRunId ||
      !isLoopLeaseActive(workspace, loopId)
    ) {
      sendApiError(res, 409, "busy", `Loop cannot accept controls: ${loopId}`);
    } else {
      await enqueueLoopControl(
        workspace,
        loopId,
        state.controlRunId,
        body.operation === "steer"
          ? { operation: "steer", message: (body.message as string).trim() }
          : { operation: body.operation },
      );
      sendJson(res, 202, { accepted: true, loopId, operation: body.operation });
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

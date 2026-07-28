import {
  archiveLoopDagResources,
  inspectLoopDagResources,
  isRecord,
  listLoopDagStates,
  loadLoopDagState,
  promoteLoopDagResult,
  pruneLoopDagResources,
} from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

export async function handleLoopDagRoutes(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, res, workspace } = ctx;
  if (segs[1] !== "loop-dags") return false;
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
  if (!dagId || segs.length !== 4 || segs[3] !== "resources") return false;
  try {
    if (method === "GET") {
      sendJson(res, 200, await inspectLoopDagResources(workspace, dagId));
    } else if (method === "POST") {
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

import { listLoopSpeculationStates, loadLoopSpeculationState, promoteLoopSpeculation } from "@seekforge/core";
import { sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

export async function handleLoopSpeculationRoutes(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, res, workspace } = ctx;
  if (segs[1] !== "loop-speculations") return false;
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

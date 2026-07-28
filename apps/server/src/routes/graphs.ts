import {
  isValidLoopDagId,
  listEngineeringGraphStates,
  loadEngineeringGraphState,
  removeEngineeringGraphState,
} from "@seekforge/core";
import { sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

export async function handleGraphRoutes(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, res, workspace } = ctx;
  if (segs[1] !== "graphs") return false;
  if (method === "GET" && segs.length === 2) {
    sendJson(
      res,
      200,
      listEngineeringGraphStates(workspace).map((state) => ({
        schemaVersion: state.schemaVersion,
        graphId: state.graphId,
        fingerprint: state.fingerprint,
        status: state.status,
        results: state.results.map(
          ({ id, kind, status, attempts, costUsd, tokensUsed, startedAt, completedAt, sessionId, error }) => ({
            id,
            kind,
            status,
            attempts,
            costUsd,
            tokensUsed,
            ...(startedAt ? { startedAt } : {}),
            ...(completedAt ? { completedAt } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(error ? { error } : {}),
          }),
        ),
        events: state.events.slice(-16),
        spentCost: state.spentCost,
        spentTokens: state.spentTokens,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        ...(state.completedAt ? { completedAt: state.completedAt } : {}),
      })),
    );
    return true;
  }
  const graphId = segs[2];
  if (!graphId || !isValidLoopDagId(graphId)) {
    sendApiError(res, 400, "bad_request", "invalid Graph id");
    return true;
  }
  if (method === "GET" && segs.length === 3) {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (state) sendJson(res, 200, state);
    else sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
    return true;
  }
  if (method === "GET" && segs.length === 4 && segs[3] === "history") {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (state) sendJson(res, 200, state.events);
    else sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
    return true;
  }
  if (method === "DELETE" && segs.length === 3) {
    try {
      if (removeEngineeringGraphState(workspace, graphId)) sendJson(res, 200, { removed: true, graphId });
      else sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  return false;
}

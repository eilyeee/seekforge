import { join } from "node:path";
import { collectTrends } from "@seekforge/eval-harness";
import { sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

export async function handle(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, res, workspace, url } = ctx;
  if (segs[1] !== "evals") return false;
  if (method !== "GET" || segs.length !== 3 || segs[2] !== "trends") return false;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) {
    sendApiError(res, 400, "bad_request", "eval trend limit must be an integer from 1 to 200");
    return true;
  }
  const limit = rawLimit === null ? 40 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    sendApiError(res, 400, "bad_request", "eval trend limit must be an integer from 1 to 200");
    return true;
  }
  try {
    const entries = collectTrends(join(workspace, "evals", "reports")).slice(-limit);
    sendJson(res, 200, { generatedAt: new Date().toISOString(), entries });
  } catch (error) {
    sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
  }
  return true;
}

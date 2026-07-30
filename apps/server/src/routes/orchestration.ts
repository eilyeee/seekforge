import {
  buildWorkspaceOrchestrationReport,
  graphExecutorsWithPlugins,
  listOrchestrationProposals,
  loadPluginContributions,
  recordOrchestrationProposals,
  setOrchestrationProposalStatus,
  type OrchestrationSloPolicy,
} from "@seekforge/core";
import { isRecord } from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import type { RouteCtx } from "./context.js";

function optionalRate(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) throw new Error(`${name} must be from 0 to 1`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be from 0 to 1`);
  return parsed;
}

function optionalPositive(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`${name} must be a positive number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function policyFromUrl(url: URL): OrchestrationSloPolicy {
  const maxP95DurationMs = optionalPositive(url.searchParams.get("maxP95DurationMs"), "maxP95DurationMs");
  const maxCostUsd = optionalPositive(url.searchParams.get("maxCostUsd"), "maxCostUsd");
  const maxFailureRate = optionalRate(url.searchParams.get("maxFailureRate"), "maxFailureRate");
  const minForecastCoverage = optionalRate(url.searchParams.get("minForecastCoverage"), "minForecastCoverage");
  return {
    ...(maxP95DurationMs === undefined ? {} : { maxP95DurationMs }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(maxFailureRate === undefined ? {} : { maxFailureRate }),
    ...(minForecastCoverage === undefined ? {} : { minForecastCoverage }),
  };
}

function orchestrationReport(ctx: RouteCtx) {
  const { workspace } = ctx;
  const policy = policyFromUrl(ctx.url);
  const executors = Object.freeze({
    ...graphExecutorsWithPlugins(loadPluginContributions(workspace), ctx.rest.graphExecutors ?? {}),
    ...(ctx.rest.graphExecutors ?? {}),
  });
  return buildWorkspaceOrchestrationReport(workspace, { policy, executors });
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, res, workspace } = ctx;
  if (segs[1] !== "orchestration") return false;
  if (method === "GET" && segs.length === 3 && segs[2] === "report") {
    try {
      sendJson(res, 200, orchestrationReport(ctx));
    } catch (error) {
      sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "GET" && segs.length === 3 && segs[2] === "proposals") {
    sendJson(res, 200, { proposals: listOrchestrationProposals(workspace) });
    return true;
  }
  if (method === "POST" && segs.length === 4 && segs[2] === "proposals" && segs[3] === "refresh") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (!isRecord(body) || Object.keys(body).length > 0) {
      sendApiError(res, 400, "bad_request", "proposal refresh body must be an empty object");
      return true;
    }
    try {
      const report = orchestrationReport(ctx);
      const drafts = [
        ...report.loops.flatMap((loop) => loop.proposals),
        ...report.graphs.flatMap((graph) => graph.optimization.proposals),
      ];
      sendJson(res, 200, { proposals: recordOrchestrationProposals(workspace, drafts) });
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (
    method === "POST" &&
    segs.length === 5 &&
    segs[2] === "proposals" &&
    (segs[4] === "approve" || segs[4] === "dismiss")
  ) {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "expectedUpdatedAt") ||
      (Object.hasOwn(body, "expectedUpdatedAt") && typeof body.expectedUpdatedAt !== "string")
    ) {
      sendApiError(res, 400, "bad_request", "proposal review body is invalid");
      return true;
    }
    try {
      sendJson(
        res,
        200,
        setOrchestrationProposalStatus(
          workspace,
          segs[3]!,
          segs[4] === "approve" ? "approved" : "dismissed",
          typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined,
        ),
      );
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  return false;
}

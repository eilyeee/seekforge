import {
  applyOrchestrationProposal,
  buildWorkspaceOrchestrationReport,
  graphExecutorsWithPlugins,
  listOrchestrationProposals,
  listOrchestrationDeployments,
  loadPluginContributions,
  observeOrchestrationDeployments,
  readWorkspaceOrchestrationSloPolicy,
  readWorkspaceOrchestrationIndex,
  recordOrchestrationProposals,
  refreshWorkspaceOrchestrationIndex,
  rollbackOrchestrationDeployment,
  setOrchestrationProposalStatus,
  setWorkspaceOrchestrationSloPolicy,
  type OrchestrationSloPolicy,
  advanceOrchestrationRollout,
  listOrchestrationRollouts,
  maintainWorkspaceOrchestration,
  reconcileOrchestrationRollouts,
  startOrchestrationRollout,
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

function optionalInteger(value: string | null, name: string, min: number, max: number): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function orchestrationReport(ctx: RouteCtx) {
  const { workspace } = ctx;
  const policy = policyFromUrl(ctx.url);
  const executors = Object.freeze({
    ...graphExecutorsWithPlugins(loadPluginContributions(workspace), ctx.rest.graphExecutors ?? {}),
    ...(ctx.rest.graphExecutors ?? {}),
  });
  const loopOffset = optionalInteger(ctx.url.searchParams.get("loopOffset"), "loopOffset", 0, 10_000);
  const graphOffset = optionalInteger(ctx.url.searchParams.get("graphOffset"), "graphOffset", 0, 10_000);
  const limit = optionalInteger(ctx.url.searchParams.get("limit"), "limit", 1, 100);
  return buildWorkspaceOrchestrationReport(workspace, {
    policy,
    executors,
    ...(loopOffset === undefined ? {} : { loopOffset }),
    ...(graphOffset === undefined ? {} : { graphOffset }),
    ...(limit === undefined ? {} : { limit }),
  });
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
    sendJson(res, 200, {
      proposals: listOrchestrationProposals(workspace),
      deployments: listOrchestrationDeployments(workspace),
    });
    return true;
  }
  if (method === "GET" && segs.length === 3 && segs[2] === "rollouts") {
    sendJson(res, 200, { rollouts: listOrchestrationRollouts(workspace) });
    return true;
  }
  if (method === "POST" && segs.length === 4 && segs[2] === "rollouts" && segs[3] === "reconcile") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "autoRollback") ||
      (body.autoRollback !== undefined && typeof body.autoRollback !== "boolean")
    ) {
      sendApiError(res, 400, "bad_request", "rollout reconciliation body is invalid");
      return true;
    }
    try {
      sendJson(res, 200, {
        rollouts: reconcileOrchestrationRollouts(workspace, { autoRollback: body.autoRollback === true }),
      });
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (
    method === "POST" &&
    segs.length === 5 &&
    segs[2] === "rollouts" &&
    (segs[4] === "start" || segs[4] === "advance")
  ) {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "expectedUpdatedAt" && key !== "minSamples") ||
      (body.expectedUpdatedAt !== undefined && typeof body.expectedUpdatedAt !== "string") ||
      (body.minSamples !== undefined && (!Number.isSafeInteger(body.minSamples) || body.minSamples !== 1)) ||
      (segs[4] === "advance" && Object.keys(body).length > 0)
    ) {
      sendApiError(res, 400, "bad_request", "rollout transition body is invalid");
      return true;
    }
    try {
      const result =
        segs[4] === "start"
          ? startOrchestrationRollout(workspace, segs[3]!, {
              ...(typeof body.expectedUpdatedAt === "string" ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}),
              ...(body.minSamples === undefined ? {} : { minSamples: body.minSamples as number }),
            })
          : advanceOrchestrationRollout(workspace, segs[3]!, {
              executors: Object.freeze({
                ...graphExecutorsWithPlugins(loadPluginContributions(workspace), ctx.rest.graphExecutors ?? {}),
                ...(ctx.rest.graphExecutors ?? {}),
              }),
            });
      sendJson(res, 200, result);
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "POST" && segs.length === 3 && segs[2] === "maintain") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "autoRollback") ||
      (body.autoRollback !== undefined && typeof body.autoRollback !== "boolean")
    ) {
      sendApiError(res, 400, "bad_request", "orchestration maintenance body is invalid");
      return true;
    }
    try {
      sendJson(
        res,
        200,
        maintainWorkspaceOrchestration(workspace, {
          executors: Object.freeze({
            ...graphExecutorsWithPlugins(loadPluginContributions(workspace), ctx.rest.graphExecutors ?? {}),
            ...(ctx.rest.graphExecutors ?? {}),
          }),
          autoRollback: body.autoRollback === true,
        }),
      );
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "GET" && segs.length === 3 && segs[2] === "policy") {
    sendJson(res, 200, readWorkspaceOrchestrationSloPolicy(workspace) ?? null);
    return true;
  }
  if (method === "GET" && segs.length === 3 && segs[2] === "index") {
    sendJson(res, 200, readWorkspaceOrchestrationIndex(workspace) ?? null);
    return true;
  }
  if (method === "POST" && segs.length === 4 && segs[2] === "index" && segs[3] === "refresh") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (!isRecord(body) || Object.keys(body).length > 0) {
      sendApiError(res, 400, "bad_request", "orchestration index refresh body must be empty");
      return true;
    }
    try {
      sendJson(res, 200, refreshWorkspaceOrchestrationIndex(workspace));
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "PUT" && segs.length === 3 && segs[2] === "policy") {
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      Object.keys(body).some(
        (key) =>
          ![
            "maxP95DurationMs",
            "maxCostUsd",
            "maxFailureRate",
            "minForecastCoverage",
            "evaluationWindow",
            "maxBreachRate",
            "expectedUpdatedAt",
          ].includes(key),
      )
    ) {
      sendApiError(res, 400, "bad_request", "orchestration policy body is invalid");
      return true;
    }
    const positiveFields = [body.maxP95DurationMs, body.maxCostUsd];
    const rateFields = [body.maxFailureRate, body.minForecastCoverage, body.maxBreachRate];
    if (
      positiveFields.some(
        (value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0),
      ) ||
      rateFields.some(
        (value) =>
          value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1),
      ) ||
      (body.evaluationWindow !== undefined &&
        (!Number.isSafeInteger(body.evaluationWindow) ||
          (body.evaluationWindow as number) < 1 ||
          (body.evaluationWindow as number) > 1_000)) ||
      (body.expectedUpdatedAt !== undefined &&
        (typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt))))
    ) {
      sendApiError(res, 400, "bad_request", "orchestration policy values are invalid");
      return true;
    }
    try {
      sendJson(
        res,
        200,
        setWorkspaceOrchestrationSloPolicy(
          workspace,
          {
            ...(body.maxP95DurationMs === undefined ? {} : { maxP95DurationMs: body.maxP95DurationMs as number }),
            ...(body.maxCostUsd === undefined ? {} : { maxCostUsd: body.maxCostUsd as number }),
            ...(body.maxFailureRate === undefined ? {} : { maxFailureRate: body.maxFailureRate as number }),
            ...(body.minForecastCoverage === undefined
              ? {}
              : { minForecastCoverage: body.minForecastCoverage as number }),
          },
          {
            ...(body.evaluationWindow === undefined ? {} : { evaluationWindow: body.evaluationWindow as number }),
            ...(body.maxBreachRate === undefined ? {} : { maxBreachRate: body.maxBreachRate as number }),
            ...(body.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: body.expectedUpdatedAt as string }),
          },
        ),
      );
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
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
      sendJson(res, 200, {
        proposals: recordOrchestrationProposals(workspace, drafts),
        index: refreshWorkspaceOrchestrationIndex(workspace),
      });
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
  if (method === "POST" && segs.length === 5 && segs[2] === "proposals" && segs[4] === "apply") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "expectedUpdatedAt") ||
      (body.expectedUpdatedAt !== undefined && typeof body.expectedUpdatedAt !== "string")
    ) {
      sendApiError(res, 400, "bad_request", "proposal apply body is invalid");
      return true;
    }
    try {
      const executors = Object.freeze({
        ...graphExecutorsWithPlugins(loadPluginContributions(workspace), ctx.rest.graphExecutors ?? {}),
        ...(ctx.rest.graphExecutors ?? {}),
      });
      sendJson(
        res,
        200,
        applyOrchestrationProposal(workspace, segs[3]!, {
          ...(typeof body.expectedUpdatedAt === "string" ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}),
          executors,
        }),
      );
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "POST" && segs.length === 5 && segs[2] === "proposals" && segs[4] === "rollback") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (!isRecord(body) || Object.keys(body).length > 0) {
      sendApiError(res, 400, "bad_request", "proposal rollback body must be empty");
      return true;
    }
    try {
      sendJson(res, 200, rollbackOrchestrationDeployment(workspace, segs[3]!));
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "POST" && segs.length === 4 && segs[2] === "deployments" && segs[3] === "observe") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      Object.keys(body).some((key) => key !== "autoRollback") ||
      (body.autoRollback !== undefined && typeof body.autoRollback !== "boolean")
    ) {
      sendApiError(res, 400, "bad_request", "deployment observation body is invalid");
      return true;
    }
    try {
      sendJson(res, 200, {
        deployments: observeOrchestrationDeployments(workspace, { autoRollback: body.autoRollback === true }),
      });
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  return false;
}

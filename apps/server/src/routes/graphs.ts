import {
  archiveEngineeringGraphResources,
  buildEngineeringGraphEvidenceReport,
  engineeringGraphStateExists,
  engineeringGraphHistoryExists,
  engineeringGraphNeedsAgentRuntime,
  enqueueGraphControl,
  graphHandlersWithPlugins,
  inspectEngineeringGraphResources,
  isRecord,
  isSessionRunActive,
  isValidLoopDagId,
  listEngineeringGraphStates,
  loadPluginContributions,
  loadEngineeringGraphState,
  materializeEngineeringGraph,
  planEngineeringGraph,
  promoteEngineeringGraphResult,
  pruneEngineeringGraphResources,
  readEngineeringGraphHistory,
  removeEngineeringGraphState,
  validateEngineeringGraphRunOptions,
  validateEngineeringGraphWorkspaces,
  type EngineeringGraphDefinition,
  type EngineeringGraphState,
  type RunEngineeringGraphOptions,
} from "@seekforge/core";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import { HEADLESS_DECLINE, type TriggerRunHandle } from "../trigger-run.js";
import type { RouteCtx } from "./context.js";

const graphRunKey = (workspace: string, graphId: string): string => `${workspace}\0${graphId}`;

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function validateRun(
  workspace: string,
  definition: EngineeringGraphDefinition,
  options: Omit<RunEngineeringGraphOptions, "workspace" | "handlers">,
): void {
  validateEngineeringGraphRunOptions(definition, {
    ...options,
    workspace,
    handlers: graphHandlersWithPlugins(loadPluginContributions(workspace)),
  });
  validateEngineeringGraphWorkspaces(definition, workspace);
  if (engineeringGraphNeedsAgentRuntime(definition) && definition.costBudgetUsd === undefined) {
    throw new Error("Server Graphs containing agent or loop nodes require costBudgetUsd");
  }
}

function trackGraphRun(ctx: RouteCtx, graphId: string, runId: string, handle: TriggerRunHandle): void {
  const { rest, workspace } = ctx;
  const key = graphRunKey(workspace, graphId);
  rest.triggerRuns?.add(handle);
  rest.graphRuns?.set(key, runId);
  void handle.started.catch(() => {});
  void handle.completion.then(
    () => {
      rest.triggerRuns?.delete(handle);
      if (rest.graphRuns?.get(key) === runId) rest.graphRuns.delete(key);
    },
    () => {
      rest.triggerRuns?.delete(handle);
      if (rest.graphRuns?.get(key) === runId) rest.graphRuns.delete(key);
    },
  );
}

function startGraphRun(
  ctx: RouteCtx,
  definition: EngineeringGraphDefinition,
  options: Omit<RunEngineeringGraphOptions, "workspace" | "handlers" | "signal" | "onEvent">,
): void {
  const { rest, workspace, res } = ctx;
  const key = graphRunKey(workspace, definition.graphId);
  if (rest.graphRuns?.has(key)) {
    sendApiError(res, 409, "busy", `Graph is already running: ${definition.graphId}`);
    return;
  }
  try {
    validateRun(workspace, definition, options);
  } catch (error) {
    sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    return;
  }
  if (isSessionRunActive(workspace, `engineering-graph-${definition.graphId}`)) {
    sendApiError(res, 409, "busy", `Graph is already running: ${definition.graphId}`);
    return;
  }
  try {
    if (!options.resume && !options.restart && engineeringGraphStateExists(workspace, definition.graphId)) {
      throw new Error(`Persisted Graph already exists; use resume or restart: ${definition.graphId}`);
    }
    if (options.resume && !loadEngineeringGraphState(workspace, definition.graphId)) {
      throw new Error(`Persisted Graph not found or invalid: ${definition.graphId}`);
    }
  } catch (error) {
    sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    return;
  }

  const ledger = rest.runManager.create({
    workspace,
    source: "graph",
    labels: { kind: "graph", graphId: definition.graphId },
  });
  const controller = new AbortController();
  rest.runManager.start(ledger.runId, workspace, controller);
  let finalState: EngineeringGraphState | undefined;
  const execute = async (): Promise<void> => {
    try {
      finalState = await rest.runGraph(
        {
          workspace,
          confirm: async () => false,
          askUser: async () => HEADLESS_DECLINE,
          extractMemory: true,
          signal: controller.signal,
        },
        definition,
        {
          ...options,
          signal: controller.signal,
          onEvent: (event) => rest.runManager.appendFrame(workspace, ledger.runId, { type: "graph.event", event }),
        },
      );
      rest.runManager.update(workspace, ledger.runId, {
        status:
          finalState.status === "passed"
            ? "succeeded"
            : finalState.status === "paused"
              ? "waiting"
              : finalState.status === "cancelled"
                ? "cancelled"
                : "failed",
        costUsd: finalState.spentCost,
        ...(finalState.status === "failed"
          ? { error: { code: "graph_failed", message: `Graph ended with status ${finalState.status}` } }
          : {}),
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      rest.runManager.update(workspace, ledger.runId, {
        status: cancelled ? "cancelled" : "failed",
        error: { code: cancelled ? "cancelled" : "graph_error", message },
      });
      rest.runManager.appendFrame(
        workspace,
        ledger.runId,
        { type: "error", code: cancelled ? "cancelled" : "graph_error", message },
        { cacheSequence: false },
      );
    }
  };
  const completion = rest.coordinator.withAgentMutation(workspace, controller.signal, execute).catch((error) => {
    const cancelled = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    rest.runManager.update(workspace, ledger.runId, {
      status: cancelled ? "cancelled" : "failed",
      error: { code: cancelled ? "cancelled" : "graph_schedule_error", message },
    });
  });
  trackGraphRun(ctx, definition.graphId, ledger.runId, {
    started: completion.then(() => ({
      sessionId: finalState?.results.find((result) => result.sessionId)?.sessionId ?? "",
    })),
    completion,
    abort: () => controller.abort(new Error("Graph cancelled by user")),
  });
  sendJson(res, 202, rest.runManager.get(workspace, ledger.runId));
}

function selectorBody(value: unknown, key: "approve" | "rerun"): string[] | undefined {
  if (!isRecord(value)) return undefined;
  const selected = value[key] ?? value.nodeIds;
  return Array.isArray(selected) ? (selected as string[]) : undefined;
}

export async function handleGraphRoutes(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, res, workspace, url, rest } = ctx;
  if (segs[1] !== "graphs") return false;

  if (method === "POST" && segs.length === 3 && segs[2] === "validate") {
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    try {
      const wrapped = isRecord(body) && body.kind !== "engineering-graph-template" && "definition" in body;
      const parameters = wrapped ? (body.parameters ?? {}) : {};
      if (!isRecord(parameters)) throw new Error("Graph parameters must be an object");
      const definition = materializeEngineeringGraph(wrapped ? body.definition : body, parameters);
      validateRun(workspace, definition, {});
      sendJson(res, 200, { valid: true, definition, plan: planEngineeringGraph(definition) });
    } catch (error) {
      sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  if (method === "POST" && segs.length === 2) {
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    if (!isRecord(body) || body.definition === undefined || (body.restart !== undefined && body.restart !== true)) {
      sendApiError(res, 400, "bad_request", "body requires definition and optional restart: true");
      return true;
    }
    try {
      if (body.parameters !== undefined && !isRecord(body.parameters)) {
        throw new Error("Graph parameters must be an object");
      }
      const definition = materializeEngineeringGraph(
        body.definition,
        (body.parameters as Record<string, unknown>) ?? {},
      );
      startGraphRun(ctx, definition, body.restart === true ? { restart: true } : {});
    } catch (error) {
      sendApiError(res, 400, "bad_request", error instanceof Error ? error.message : String(error));
    }
    return true;
  }

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
          ({
            id,
            kind,
            status,
            attempts,
            costUsd,
            tokensUsed,
            startedAt,
            completedAt,
            sessionId,
            error,
            managedBranch,
          }) => ({
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
            ...(managedBranch ? { managedBranch } : {}),
          }),
        ),
        events: state.events.slice(-16),
        spentCost: state.spentCost,
        spentTokens: state.spentTokens,
        ...(state.activeAttempts.length > 0 ? { activeAttempts: state.activeAttempts } : {}),
        ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        ...(state.completedAt ? { completedAt: state.completedAt } : {}),
        ...(state.parentGraph ? { parentGraph: state.parentGraph } : {}),
        ...(state.resourceGeneration ? { resourceGeneration: state.resourceGeneration } : {}),
        ...(state.fanIn ? { fanIn: state.fanIn } : {}),
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
    if (!state) {
      sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
      return true;
    }
    const afterSeq = boundedInteger(url.searchParams.get("afterSeq"), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(url.searchParams.get("limit"), 500, 1, 1_999);
    if (afterSeq === null || limit === null) {
      sendApiError(res, 400, "bad_request", "history cursor or limit is invalid");
      return true;
    }
    const hasDurableHistory = engineeringGraphHistoryExists(workspace, graphId);
    let entries = readEngineeringGraphHistory(workspace, graphId, { afterSeq, limit: limit + 1 });
    if (!hasDurableHistory) {
      entries = state.events
        .filter((event) => event.sequence > afterSeq)
        .slice(0, limit + 1)
        .map((event) => ({ seq: event.sequence, event }));
    }
    const hasMore = entries.length > limit;
    entries = entries.slice(0, limit);
    if (url.searchParams.get("format") === "entries") {
      sendJson(res, 200, { entries, nextAfterSeq: entries.at(-1)?.seq ?? afterSeq, hasMore });
    } else {
      sendJson(
        res,
        200,
        entries.map((entry) => entry.event),
      );
    }
    return true;
  }
  if (method === "GET" && segs.length === 4 && segs[3] === "evidence") {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (state) sendJson(res, 200, buildEngineeringGraphEvidenceReport(state));
    else sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
    return true;
  }
  if (segs.length === 4 && segs[3] === "resources") {
    if (!loadEngineeringGraphState(workspace, graphId)) {
      sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
      return true;
    }
    try {
      if (method === "GET") sendJson(res, 200, await inspectEngineeringGraphResources(workspace, graphId));
      else if (method === "POST") {
        const body = await readJsonBody(ctx.req, res);
        if (body === undefined) return true;
        if (!isRecord(body)) sendApiError(res, 400, "bad_request", "body must be an object");
        else if (body.operation === "archive") {
          sendJson(res, 200, archiveEngineeringGraphResources(workspace, graphId));
        } else if (body.operation === "prune") {
          if (
            (body.dryRun !== undefined && typeof body.dryRun !== "boolean") ||
            (body.force !== undefined && typeof body.force !== "boolean")
          ) {
            sendApiError(res, 400, "bad_request", "dryRun and force must be boolean");
          } else {
            sendJson(
              res,
              200,
              await pruneEngineeringGraphResources(workspace, graphId, {
                dryRun: body.dryRun as boolean | undefined,
                force: body.force as boolean | undefined,
              }),
            );
          }
        } else if (body.operation === "promote" && typeof body.target === "string") {
          sendJson(res, 200, await promoteEngineeringGraphResult(workspace, graphId, body.target));
        } else sendApiError(res, 400, "bad_request", "unknown Graph resource operation");
      } else return false;
    } catch (error) {
      sendApiError(res, 409, "conflict", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "POST" && segs.length === 4 && segs[3] === "cancel") {
    const runId = rest.graphRuns?.get(graphRunKey(workspace, graphId));
    if (!runId) sendApiError(res, 409, "not_running", `Graph is not running: ${graphId}`);
    else sendJson(res, 200, rest.runManager.cancel(workspace, runId));
    return true;
  }
  if (method === "POST" && segs.length === 4 && segs[3] === "control") {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (!state) {
      sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
      return true;
    }
    if (
      state.status !== "running" ||
      !state.controlRunId ||
      !isSessionRunActive(workspace, `engineering-graph-${graphId}`)
    ) {
      sendApiError(res, 409, "not_running", `Graph is not running: ${graphId}`);
      return true;
    }
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    if (
      !isRecord(body) ||
      (body.operation !== "pause" && body.operation !== "resume" && body.operation !== "steer") ||
      (body.operation === "steer" && typeof body.message !== "string") ||
      (body.operation !== "steer" && body.message !== undefined)
    ) {
      sendApiError(res, 400, "bad_request", "Graph control requires pause, resume, or steer");
      return true;
    }
    try {
      const entry = await enqueueGraphControl(
        workspace,
        graphId,
        state.controlRunId,
        body.operation === "steer"
          ? { operation: "steer", message: body.message as string }
          : { operation: body.operation },
      );
      sendJson(res, 202, entry);
    } catch (error) {
      sendApiError(res, 409, "conflict", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (method === "POST" && segs.length === 4 && ["resume", "approve", "rerun", "restart"].includes(segs[3]!)) {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (!state) {
      sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
      return true;
    }
    const action = segs[3]!;
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (!isRecord(body)) {
      sendApiError(res, 400, "bad_request", "body must be an object");
      return true;
    }
    if (
      (action === "resume" && body.nodeIds !== undefined) ||
      (action === "approve" && body.rerun !== undefined) ||
      (action === "rerun" && body.approve !== undefined) ||
      (action === "restart" && (body.approve !== undefined || body.rerun !== undefined || body.nodeIds !== undefined))
    ) {
      sendApiError(res, 400, "bad_request", `selectors are not valid for Graph ${action}`);
      return true;
    }
    const selectorName = action === "approve" ? "approve" : action === "rerun" ? "rerun" : undefined;
    if (
      selectorName !== undefined &&
      ((body[selectorName] === undefined && body.nodeIds === undefined) ||
        (body[selectorName] !== undefined && body.nodeIds !== undefined) ||
        (body[selectorName] !== undefined && !Array.isArray(body[selectorName])) ||
        (body.nodeIds !== undefined && !Array.isArray(body.nodeIds)))
    ) {
      sendApiError(res, 400, "bad_request", `${action} requires exactly one array selector`);
      return true;
    }
    if (
      action === "resume" &&
      ((body.approve !== undefined && !Array.isArray(body.approve)) ||
        (body.rerun !== undefined && !Array.isArray(body.rerun)))
    ) {
      sendApiError(res, 400, "bad_request", "resume selectors must be arrays");
      return true;
    }
    const approve = action === "rerun" || action === "restart" ? undefined : selectorBody(body, "approve");
    const rerun = action === "approve" || action === "restart" ? undefined : selectorBody(body, "rerun");
    const options =
      action === "restart"
        ? ({ restart: true } as const)
        : {
            resume: true as const,
            ...(approve !== undefined ? { approvedNodeIds: approve } : {}),
            ...(rerun !== undefined ? { rerunFrom: rerun } : {}),
          };
    startGraphRun(ctx, state.definition, options);
    return true;
  }
  if (method === "DELETE" && segs.length === 3) {
    if (rest.graphRuns?.has(graphRunKey(workspace, graphId))) {
      sendApiError(res, 409, "busy", `Graph is currently running: ${graphId}`);
      return true;
    }
    if (!loadEngineeringGraphState(workspace, graphId)) {
      sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
      return true;
    }
    try {
      const resources = await inspectEngineeringGraphResources(workspace, graphId);
      if (resources.worktrees.length > 0) {
        throw new Error(`Graph managed resources must be pruned before deletion: ${graphId}`);
      }
      if (removeEngineeringGraphState(workspace, graphId)) {
        sendJson(res, 200, { removed: true, graphId });
      } else sendApiError(res, 404, "not_found", `unknown Graph: ${graphId}`);
    } catch (error) {
      sendApiError(res, 409, "busy", error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  return false;
}

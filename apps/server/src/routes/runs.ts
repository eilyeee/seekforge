import { MAX_LOOP_ITERATIONS } from "@seekforge/core";
import { parseLoopVerificationPlan, type LoopVerificationStage } from "@seekforge/shared";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import { RUN_RETENTION_MAX_AGE_DAYS, RUN_RETENTION_MAX_COUNT } from "../run-ledger.js";
import { isolateRunWorkspace, type RunIsolation } from "../run-isolation.js";
import { beginRunSessionMirror } from "../run-trace-mirror.js";
import { HEADLESS_DECLINE, startManagedTriggerRun, type TriggerRunHandle } from "../trigger-run.js";
import type { RouteCtx } from "./context.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes the declared verification pipeline with the one owner of its rules.
 * A REST body is authored text a client just wrote — not a plan replayed from
 * persisted state — so an unknown stage field is a hard error rather than a
 * field to drop: the route would otherwise start a run whose plan is quietly
 * not the one that was requested. The engine's own ceiling applies to a stage
 * timeout, because this route feeds `runAutoLoop` directly and must not refuse
 * what the engine would run.
 */
function verificationStages(value: unknown): LoopVerificationStage[] | string {
  try {
    return parseLoopVerificationPlan(value, { label: "verificationPlan", rejectUnknownFields: true });
  } catch (error) {
    return error instanceof Error ? error.message : "verificationPlan is invalid";
  }
}

function trackRun(rest: RouteCtx["rest"], run: TriggerRunHandle): void {
  rest.triggerRuns?.add(run);
  void run.started.catch(() => {});
  void run.completion.then(
    () => rest.triggerRuns?.delete(run),
    () => rest.triggerRuns?.delete(run),
  );
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  const { method, segs, url, res, ws, workspace, rest } = ctx;
  if (segs[1] !== "runs") return false;

  if (method === "GET" && segs.length === 2) {
    sendJson(res, 200, rest.runManager.list(workspace));
    return true;
  }

  if (method === "POST" && segs.length === 2) {
    const body = await readJsonBody(ctx.req, res);
    if (body === undefined) return true;
    if (!object(body)) {
      sendApiError(res, 400, "bad_request", "run body must be an object");
      return true;
    }
    const {
      kind = "agent",
      task,
      mode: requestedMode,
      maxCostUsd,
      verifyCommand,
      maxIterations,
      tokenBudget,
      maxDurationMs,
      maxVerifyRuns,
      verifyTimeoutMs,
      agentTimeoutMs,
      maxAgentRetries,
      verificationPlan,
      stablePasses,
      flakyRetries,
      maxNoProgressRecoveries,
      rollbackOnRegression,
      priority,
      requirementMode,
      isolation = "auto",
    } = body;
    const mode = requestedMode ?? (kind === "loop" ? "edit" : "ask");
    if (kind !== "agent" && kind !== "loop") {
      sendApiError(res, 400, "bad_request", 'kind must be "agent" or "loop"');
      return true;
    }
    if (typeof task !== "string" || task.trim() === "") {
      sendApiError(res, 400, "bad_request", "task must be a non-empty string");
      return true;
    }
    if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      sendApiError(res, 400, "bad_request", "maxCostUsd must be a finite positive number");
      return true;
    }
    if (mode !== "ask" && mode !== "edit") {
      sendApiError(res, 400, "bad_request", 'mode must be "ask" or "edit"');
      return true;
    }
    if (kind === "loop" && mode !== "edit") {
      sendApiError(res, 400, "bad_request", 'loop mode must be "edit"');
      return true;
    }
    if (kind === "loop" && (typeof verifyCommand !== "string" || verifyCommand.trim() === "")) {
      sendApiError(res, 400, "bad_request", "loop.verifyCommand must be a non-empty string");
      return true;
    }
    if (
      maxIterations !== undefined &&
      (!Number.isSafeInteger(maxIterations) ||
        (maxIterations as number) <= 0 ||
        (maxIterations as number) > MAX_LOOP_ITERATIONS)
    ) {
      sendApiError(res, 400, "bad_request", `maxIterations must be an integer from 1 to ${MAX_LOOP_ITERATIONS}`);
      return true;
    }
    for (const [name, value, allowZero] of [
      ["tokenBudget", tokenBudget, false],
      ["maxDurationMs", maxDurationMs, false],
      ["maxVerifyRuns", maxVerifyRuns, false],
      ["verifyTimeoutMs", verifyTimeoutMs, false],
      ["agentTimeoutMs", agentTimeoutMs, false],
      ["maxAgentRetries", maxAgentRetries, true],
      ["stablePasses", stablePasses, false],
      ["flakyRetries", flakyRetries, true],
      ["maxNoProgressRecoveries", maxNoProgressRecoveries, true],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1))) {
        sendApiError(
          res,
          400,
          "bad_request",
          `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
        );
        return true;
      }
    }
    if (typeof stablePasses === "number" && stablePasses > 5) {
      sendApiError(res, 400, "bad_request", "stablePasses must be 1-5");
      return true;
    }
    if (typeof flakyRetries === "number" && flakyRetries > 5) {
      sendApiError(res, 400, "bad_request", "flakyRetries must be 0-5");
      return true;
    }
    if (typeof maxNoProgressRecoveries === "number" && maxNoProgressRecoveries > 5) {
      sendApiError(res, 400, "bad_request", "maxNoProgressRecoveries must be 0-5");
      return true;
    }
    if (rollbackOnRegression !== undefined && typeof rollbackOnRegression !== "boolean") {
      sendApiError(res, 400, "bad_request", "rollbackOnRegression must be boolean");
      return true;
    }
    if (
      priority !== undefined &&
      (!Number.isSafeInteger(priority) || (priority as number) < -10 || (priority as number) > 10)
    ) {
      sendApiError(res, 400, "bad_request", "priority must be an integer from -10 to 10");
      return true;
    }
    const decodedVerificationPlan = verificationPlan === undefined ? undefined : verificationStages(verificationPlan);
    if (typeof decodedVerificationPlan === "string") {
      sendApiError(res, 400, "bad_request", decodedVerificationPlan);
      return true;
    }
    const parsedVerificationPlan: LoopVerificationStage[] | undefined = decodedVerificationPlan;
    if (
      requirementMode !== undefined &&
      requirementMode !== "quick" &&
      requirementMode !== "analyze" &&
      requirementMode !== "confirm"
    ) {
      sendApiError(res, 400, "bad_request", 'requirementMode must be "quick", "analyze", or "confirm"');
      return true;
    }
    if (isolation !== "auto" && isolation !== "workspace" && isolation !== "worktree") {
      sendApiError(res, 400, "bad_request", 'isolation must be "auto", "workspace", or "worktree"');
      return true;
    }

    const isolated = await isolateRunWorkspace(
      rest,
      ws,
      mode,
      isolation as RunIsolation,
      `background-${Date.now().toString(36)}`,
    );
    const executionWorkspace = isolated.workspace;
    const ledgerRun = rest.runManager.create({
      workspace,
      source: "background",
      labels: { kind, ...isolated.labels },
    });
    if (kind === "agent") {
      const run = startManagedTriggerRun({
        createAgent: rest.createAgent,
        workspace: executionWorkspace,
        ledgerWorkspace: workspace,
        task,
        mode,
        maxCostUsd,
        runManager: rest.runManager,
        runId: ledgerRun.runId,
        ...(mode === "edit"
          ? {
              schedule: (operation: () => Promise<void>, signal: AbortSignal) =>
                rest.coordinator.withAgentMutation(executionWorkspace, signal, operation),
            }
          : {}),
      });
      trackRun(rest, run);
    } else {
      const controller = new AbortController();
      rest.runManager.start(ledgerRun.runId, workspace, controller);
      let finalSessionId = "";
      const execute = async (): Promise<void> => {
        // A Loop is isolated the same way an agent run is, so its trace is
        // written in the worktree while its ledger entry lives here. Opened
        // before the Loop writes anything and finished on every ending, so the
        // sessionId recorded below stays openable in this checkout after the
        // worktree is merged or removed.
        const mirror = beginRunSessionMirror(executionWorkspace, workspace);
        try {
          controller.signal.throwIfAborted();
          const result = await rest.runLoop(
            {
              workspace: executionWorkspace,
              confirm: async () => false,
              askUser: async () => HEADLESS_DECLINE,
              extractMemory: mode === "edit",
            },
            {
              workspace: executionWorkspace,
              task,
              verifyCommand: verifyCommand as string,
              ...(maxIterations !== undefined ? { maxIterations: maxIterations as number } : {}),
              ...(tokenBudget !== undefined ? { tokenBudget: tokenBudget as number } : {}),
              ...(maxDurationMs !== undefined ? { maxDurationMs: maxDurationMs as number } : {}),
              ...(maxVerifyRuns !== undefined ? { maxVerifyRuns: maxVerifyRuns as number } : {}),
              ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs: verifyTimeoutMs as number } : {}),
              ...(agentTimeoutMs !== undefined ? { agentTimeoutMs: agentTimeoutMs as number } : {}),
              ...(maxAgentRetries !== undefined ? { maxAgentRetries: maxAgentRetries as number } : {}),
              ...(parsedVerificationPlan !== undefined ? { verificationPlan: parsedVerificationPlan } : {}),
              ...(stablePasses !== undefined ? { stablePasses: stablePasses as number } : {}),
              ...(flakyRetries !== undefined ? { flakyRetries: flakyRetries as number } : {}),
              ...(maxNoProgressRecoveries !== undefined
                ? { maxNoProgressRecoveries: maxNoProgressRecoveries as number }
                : {}),
              ...(rollbackOnRegression !== undefined ? { rollbackOnRegression } : {}),
              ...(priority !== undefined ? { priority: priority as number } : {}),
              ...(requirementMode !== undefined ? { requirementMode } : {}),
              costBudgetUsd: maxCostUsd,
              approvalMode: "acceptEdits",
              signal: controller.signal,
              onEvent: (event) =>
                rest.runManager.appendFrame(workspace, ledgerRun.runId, { type: "loop.event", event }),
            },
          );
          finalSessionId = result.sessionId;
          rest.runManager.update(workspace, ledgerRun.runId, {
            status:
              result.status === "passed"
                ? "succeeded"
                : result.status === "cancelled"
                  ? "cancelled"
                  : result.status === "requirements_pending"
                    ? "waiting"
                    : "failed",
            sessionId: result.sessionId,
            costUsd: result.costUsd,
            ...(result.status !== "passed" && result.status !== "requirements_pending"
              ? { error: { code: result.status, message: `loop ended with status ${result.status}` } }
              : {}),
          });
        } catch (err) {
          const cancelled = controller.signal.aborted;
          const message = err instanceof Error ? err.message : String(err);
          rest.runManager.update(workspace, ledgerRun.runId, {
            status: cancelled ? "cancelled" : "failed",
            error: {
              code: cancelled ? "cancelled" : "loop_error",
              message,
            },
          });
          rest.runManager.appendFrame(
            workspace,
            ledgerRun.runId,
            { type: "error", code: cancelled ? "cancelled" : "loop_error", message },
            { cacheSequence: false },
          );
        } finally {
          const { mirrored } = mirror.finish({
            runManager: rest.runManager,
            runId: ledgerRun.runId,
            sessionId: finalSessionId,
          });
          // A Loop that threw never reported its session id, so its mirrored
          // trace would sit in this checkout with nothing in the ledger naming
          // it. Only when the attribution is unambiguous.
          const only = mirrored.length === 1 ? mirrored[0] : undefined;
          if (finalSessionId === "" && only !== undefined) {
            rest.runManager.update(workspace, ledgerRun.runId, { sessionId: only });
          }
        }
      };
      const completion = rest.coordinator
        .withAgentMutation(executionWorkspace, controller.signal, execute)
        .catch((err) => {
          // The coordinator may reject before execute starts (for example when an
          // already-aborted run is still waiting for a cross-process lease).
          const cancelled = controller.signal.aborted;
          const message = err instanceof Error ? err.message : String(err);
          rest.runManager.update(workspace, ledgerRun.runId, {
            status: cancelled ? "cancelled" : "failed",
            error: { code: cancelled ? "cancelled" : "loop_schedule_error", message },
          });
          rest.runManager.appendFrame(
            workspace,
            ledgerRun.runId,
            { type: "error", code: cancelled ? "cancelled" : "loop_error", message },
            { cacheSequence: false },
          );
        });
      trackRun(rest, {
        started: completion.then(() => ({ sessionId: finalSessionId })),
        completion,
        abort: () => controller.abort(),
      });
    }
    sendJson(res, 202, rest.runManager.get(workspace, ledgerRun.runId));
    return true;
  }

  if (method === "POST" && segs.length === 3 && segs[2] === "prune") {
    const body = await readJsonBody(ctx.req, res, { emptyOk: true });
    if (body === undefined) return true;
    if (!object(body)) {
      sendApiError(res, 400, "bad_request", "retention policy must be an object");
      return true;
    }
    const { maxTerminalRuns, maxAgeDays } = body;
    if (
      maxTerminalRuns !== undefined &&
      (!Number.isSafeInteger(maxTerminalRuns) ||
        (maxTerminalRuns as number) < 0 ||
        (maxTerminalRuns as number) > RUN_RETENTION_MAX_COUNT)
    ) {
      sendApiError(res, 400, "bad_request", `maxTerminalRuns must be an integer from 0 to ${RUN_RETENTION_MAX_COUNT}`);
      return true;
    }
    if (
      maxAgeDays !== undefined &&
      (typeof maxAgeDays !== "number" ||
        !Number.isFinite(maxAgeDays) ||
        maxAgeDays <= 0 ||
        maxAgeDays > RUN_RETENTION_MAX_AGE_DAYS)
    ) {
      sendApiError(
        res,
        400,
        "bad_request",
        `maxAgeDays must be greater than 0 and at most ${RUN_RETENTION_MAX_AGE_DAYS}`,
      );
      return true;
    }
    sendJson(
      res,
      200,
      rest.runManager.prune(workspace, {
        maxTerminalRuns: maxTerminalRuns as number | undefined,
        maxAgeDays: maxAgeDays as number | undefined,
      }),
    );
    return true;
  }

  const id = segs[2];
  if (!id) return false;
  const run = rest.runManager.get(workspace, id);
  if (!run) {
    sendApiError(res, 404, "not_found", `run not found: ${id}`);
    return true;
  }

  if (method === "GET" && segs.length === 3) {
    sendJson(res, 200, run);
    return true;
  }

  if (method === "GET" && segs.length === 4 && segs[3] === "events") {
    const raw = url.searchParams.get("afterSeq") ?? "0";
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      sendApiError(res, 400, "bad_request", "afterSeq must be a non-negative safe integer");
      return true;
    }
    sendJson(res, 200, rest.runManager.eventPage(workspace, id, Number(raw)));
    return true;
  }

  if (method === "POST" && segs.length === 4 && segs[3] === "cancel") {
    if ((run.status === "queued" || run.status === "running") && !rest.runManager.ownsActiveRun(workspace, id)) {
      sendApiError(res, 409, "conflict", "run is active in another server process and cannot be cancelled here");
      return true;
    }
    const cancelled = rest.runManager.cancel(workspace, id);
    sendJson(res, 200, cancelled);
    return true;
  }
  if (method === "DELETE" && segs.length === 3) {
    if ((run.status === "queued" || run.status === "running") && !rest.runManager.ownsActiveRun(workspace, id)) {
      sendApiError(res, 409, "conflict", "run is active in another server process and cannot be cancelled here");
      return true;
    }
    sendJson(res, 200, rest.runManager.cancel(workspace, id));
    return true;
  }
  return false;
}

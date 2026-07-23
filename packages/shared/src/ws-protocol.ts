import type { ClientFrame, RunOverrides } from "./index.js";

export type ClientFrameLimits = {
  maxLoopIterations: number;
  maxSteerMessageLength: number;
};

export type ClientFrameDecodeResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; error: string; permissionRequestId?: string };

type RecordValue = Record<string, unknown>;

const LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/;
const DISPATCH_ID_RE = /^ag-[1-9]\d*$/;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(error: string, permissionRequestId?: string): ClientFrameDecodeResult {
  return permissionRequestId === undefined ? { ok: false, error } : { ok: false, error, permissionRequestId };
}

function workspaceError(frame: RecordValue, prefix: string): string | undefined {
  return frame["ws"] !== undefined && typeof frame["ws"] !== "string"
    ? `${prefix}.ws must be a string when present`
    : undefined;
}

function parseOverrides(frame: RecordValue): { value: RunOverrides } | { error: string } {
  const { model, thinking, reasoningEffort, outputStyle, sandbox } = frame;
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
    return { error: "model must be a non-empty string when present" };
  }
  if (thinking !== undefined && typeof thinking !== "boolean") {
    return { error: "thinking must be a boolean when present" };
  }
  if (reasoningEffort !== undefined && reasoningEffort !== "high" && reasoningEffort !== "max") {
    return { error: 'reasoningEffort must be "high" or "max" when present' };
  }
  if (outputStyle !== undefined && (typeof outputStyle !== "string" || outputStyle.length === 0)) {
    return { error: "outputStyle must be a non-empty string when present" };
  }
  if (
    sandbox !== undefined &&
    sandbox !== "off" &&
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "restricted"
  ) {
    return { error: 'sandbox must be "off", "read-only", "workspace-write", or "restricted" when present' };
  }
  return {
    value: {
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(outputStyle !== undefined ? { outputStyle } : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
    },
  };
}

function parseRecord(frame: RecordValue, limits: ClientFrameLimits): ClientFrameDecodeResult {
  const type = frame["type"];
  if (typeof type !== "string") return bad("frames must be JSON objects with a type field");

  if (type === "start") {
    const { task, mode, approvalMode, plan } = frame;
    if (typeof task !== "string" || task.trim().length === 0) return bad("start.task must be a non-empty string");
    if (mode !== "edit" && mode !== "ask") return bad('start.mode must be "edit" or "ask"');
    if (approvalMode !== "auto" && approvalMode !== "acceptEdits" && approvalMode !== "confirm") {
      return bad('start.approvalMode must be "auto", "acceptEdits", or "confirm"');
    }
    if (plan !== undefined && typeof plan !== "boolean") return bad("start.plan must be a boolean when present");
    const wsError = workspaceError(frame, "start");
    if (wsError) return bad(wsError);
    const overrides = parseOverrides(frame);
    if ("error" in overrides) return bad(`start.${overrides.error}`);
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "send") {
    const { sessionId, task, mode, approvalMode } = frame;
    if (typeof sessionId !== "string" || typeof task !== "string" || task.trim().length === 0) {
      return bad("send needs sessionId and a non-empty task");
    }
    if (mode !== undefined && mode !== "edit" && mode !== "ask") {
      return bad('send.mode must be "edit" or "ask" when present');
    }
    if (
      approvalMode !== undefined &&
      approvalMode !== "auto" &&
      approvalMode !== "acceptEdits" &&
      approvalMode !== "confirm"
    ) {
      return bad('send.approvalMode must be "auto", "acceptEdits", or "confirm" when present');
    }
    const wsError = workspaceError(frame, "send");
    if (wsError) return bad(wsError);
    const overrides = parseOverrides(frame);
    if ("error" in overrides) return bad(`send.${overrides.error}`);
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "loop") {
    const {
      task,
      verifyCommand,
      maxIterations,
      budget,
      tokenBudget,
      maxDurationMs,
      maxVerifyRuns,
      verifyTimeoutMs,
      agentTimeoutMs,
      maxAgentRetries,
      requirementMode,
    } = frame;
    if (typeof task !== "string" || task.trim().length === 0) return bad("loop.task must be a non-empty string");
    if (typeof verifyCommand !== "string" || verifyCommand.trim().length === 0) {
      return bad("loop.verifyCommand must be a non-empty string");
    }
    if (
      maxIterations !== undefined &&
      (typeof maxIterations !== "number" ||
        !Number.isInteger(maxIterations) ||
        maxIterations <= 0 ||
        maxIterations > limits.maxLoopIterations)
    ) {
      return bad(`loop.maxIterations must be an integer from 1 to ${limits.maxLoopIterations}`);
    }
    if (budget !== undefined && (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0)) {
      return bad("loop.budget must be a finite positive number when present");
    }
    for (const [name, value, allowZero] of [
      ["tokenBudget", tokenBudget, false],
      ["maxDurationMs", maxDurationMs, false],
      ["maxVerifyRuns", maxVerifyRuns, false],
      ["verifyTimeoutMs", verifyTimeoutMs, false],
      ["agentTimeoutMs", agentTimeoutMs, false],
      ["maxAgentRetries", maxAgentRetries, true],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
      ) {
        return bad(`loop.${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
      }
    }
    if (
      requirementMode !== undefined &&
      requirementMode !== "quick" &&
      requirementMode !== "analyze" &&
      requirementMode !== "confirm"
    ) {
      return bad('loop.requirementMode must be "quick", "analyze", or "confirm"');
    }
    const wsError = workspaceError(frame, "loop");
    if (wsError) return bad(wsError);
    const overrides = parseOverrides(frame);
    if ("error" in overrides) return bad(`loop.${overrides.error}`);
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "loop.resume") {
    const {
      loopId,
      addedIterations,
      addedBudget,
      addedTokenBudget,
      addedDurationMs,
      addedVerifyRuns,
      approveRequirements,
    } = frame;
    if (typeof loopId !== "string" || !LOOP_ID_RE.test(loopId)) {
      return bad("loop.resume.loopId must be a safe non-empty id");
    }
    if (
      addedIterations !== undefined &&
      (typeof addedIterations !== "number" ||
        !Number.isInteger(addedIterations) ||
        addedIterations <= 0 ||
        addedIterations > limits.maxLoopIterations)
    ) {
      return bad(`loop.resume.addedIterations must be an integer from 1 to ${limits.maxLoopIterations}`);
    }
    if (approveRequirements !== undefined && typeof approveRequirements !== "boolean") {
      return bad("loop.resume.approveRequirements must be a boolean when present");
    }
    if (
      addedBudget !== undefined &&
      (typeof addedBudget !== "number" || !Number.isFinite(addedBudget) || addedBudget <= 0)
    ) {
      return bad("loop.resume.addedBudget must be a finite positive number when present");
    }
    for (const [name, value] of [
      ["addedTokenBudget", addedTokenBudget],
      ["addedDurationMs", addedDurationMs],
      ["addedVerifyRuns", addedVerifyRuns],
    ] as const) {
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
        return bad(`loop.resume.${name} must be a positive safe integer`);
      }
    }
    const wsError = workspaceError(frame, "loop.resume");
    if (wsError) return bad(wsError);
    const overrides = parseOverrides(frame);
    if ("error" in overrides) return bad(`loop.resume.${overrides.error}`);
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "permission.response") {
    const requestId = typeof frame["requestId"] === "string" ? frame["requestId"] : undefined;
    if (!requestId || typeof frame["approved"] !== "boolean") {
      return bad("permission.response needs requestId and approved", requestId);
    }
    if (frame["remember"] !== undefined && frame["remember"] !== "session") {
      return bad('permission.response.remember must be "session" when present', requestId);
    }
    const selectedHunks = frame["selectedHunks"];
    if (
      selectedHunks !== undefined &&
      (!Array.isArray(selectedHunks) ||
        selectedHunks.length === 0 ||
        selectedHunks.length > 10_000 ||
        !selectedHunks.every((index) => Number.isSafeInteger(index) && (index as number) >= 0))
    ) {
      return bad("permission.response.selectedHunks must contain 1-10000 non-negative safe integers", requestId);
    }
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "question.answer") {
    if (typeof frame["id"] !== "string" || typeof frame["answer"] !== "string") {
      return bad("question.answer needs string id and answer");
    }
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "subagent.cancel" || type === "subagent.steer") {
    const allowed =
      type === "subagent.cancel" ? new Set(["type", "dispatchId"]) : new Set(["type", "dispatchId", "message"]);
    if (Object.keys(frame).some((key) => !allowed.has(key))) return bad(`${type} contains unsupported fields`);
    const dispatchId = frame["dispatchId"];
    if (typeof dispatchId !== "string" || !DISPATCH_ID_RE.test(dispatchId) || dispatchId.length > 64) {
      return bad(`${type}.dispatchId must be a valid dispatch id`);
    }
    if (type === "subagent.steer") {
      const message = frame["message"];
      if (typeof message !== "string" || message.trim().length === 0 || message.length > limits.maxSteerMessageLength) {
        return bad(`subagent.steer.message must contain 1-${limits.maxSteerMessageLength} characters`);
      }
    }
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "subscribe") {
    const { runId, afterSeq } = frame;
    if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return bad("subscribe.runId must be a valid run id");
    if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || (afterSeq as number) < 0)) {
      return bad("subscribe.afterSeq must be a non-negative safe integer");
    }
    const wsError = workspaceError(frame, "subscribe");
    if (wsError) return bad(wsError);
    return { ok: true, frame: frame as ClientFrame };
  }

  if (type === "cancel") return { ok: true, frame: frame as ClientFrame };
  return bad(`unknown frame type: ${type}`);
}

export function parseClientFrame(value: unknown, limits: ClientFrameLimits): ClientFrameDecodeResult {
  return isRecord(value) ? parseRecord(value, limits) : bad("frames must be JSON objects with a type field");
}

export function decodeClientFrame(text: string, limits: ClientFrameLimits): ClientFrameDecodeResult {
  try {
    return parseClientFrame(JSON.parse(text) as unknown, limits);
  } catch {
    return bad("frames must be JSON objects with a type field");
  }
}

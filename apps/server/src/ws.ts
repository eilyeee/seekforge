/**
 * WebSocket protocol (/ws) — drives agent runs (SERVER-API.md).
 *
 * One connection drives at most one *running* session at a time (busy rule).
 * Permission requests pause the run until the matching permission.response,
 * a 120 s timeout, or socket close (both treated as denied). ask_user
 * questions bridge the same way (question.request/question.answer; timeout
 * or close resolves as a declined answer). Socket close while running aborts
 * the run via AbortController.
 */

import type { RawData, WebSocket } from "ws";
import {
  MAX_LOOP_ITERATIONS,
  MAX_STEER_MESSAGE_LENGTH,
  createDispatchManager,
  detectThinkingKeyword,
  isValidLoopId,
  readSessionMeta,
  resolveOutputStyle,
  type DispatchManager,
} from "@seekforge/core";
import type { ApiErrorCode, ApprovalMode, ConfirmResult, PermissionRequest, ServerFrame } from "@seekforge/shared";
import type { CreateAgentFn, ResumeLoopFn, RunLoopFn, RunOverrides } from "./agent.js";
import { isSafeId } from "./ids.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  SERVER_CAPABILITIES,
  SERVER_PROTOCOL_VERSION,
  type RunEvent,
  type RunManager,
  type RunStatus,
} from "./run-ledger.js";

export const PERMISSION_TIMEOUT_MS = 120_000;

/**
 * Model/reasoning delta chunks are buffered per session and flushed as one
 * concatenated frame at most this often, instead of one JSON.stringify +
 * ws.send frame per token. 25ms is imperceptible to a reader but collapses a
 * fast token stream into ~40 frames/s.
 */
export const DELTA_FLUSH_MS = 25;
export const SUBSCRIPTION_POLL_MS = 250;

/** Answer reported to the core when the user never answers an ask_user question. */
export const DECLINED_ANSWER = "(the user declined to answer)";

export type ConnectionDeps = {
  registry: WorkspaceRegistry;
  createAgent: CreateAgentFn;
  runLoop: RunLoopFn;
  resumeLoop: ResumeLoopFn;
  permissionTimeoutMs?: number;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
  withRepository?: <T>(workspace: string, operation: () => Promise<T>) => Promise<T>;
  withAgentMutation?: <T>(workspace: string, signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
  runManager: RunManager;
};

type RunInput = {
  task: string;
  mode: "ask" | "edit";
  /** Plan flavor of ask mode (passed through to the core, not enforced here). */
  plan?: boolean;
  approvalMode: ApprovalMode;
  resumeSessionId?: string;
  /** Absolute path of the workspace this run targets (resolved from `ws`). */
  workspace: string;
  /** Per-run model/thinking overrides from the frame (win over config). */
  overrides?: RunOverrides;
};

type RunSubscription = {
  workspace: string;
  runId: string;
  afterSeq: number;
  fileIdentity?: string;
  catchingUp: boolean;
  pendingLocal: Array<{ event: RunEvent; identity: string }>;
  unsubscribe?: () => void;
  timer?: NodeJS.Timeout;
};

/**
 * Validates the optional per-run override fields of a start/send frame.
 * Returns the overrides object (undefined when none are present) or an
 * error string describing the first invalid field.
 */
export function parseRunOverrides(frame: Record<string, unknown>): { overrides?: RunOverrides } | { error: string } {
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
  const overrides: RunOverrides = {
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(outputStyle !== undefined ? { outputStyle } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
  };
  return Object.keys(overrides).length > 0 ? { overrides } : {};
}

export function handleConnection(ws: WebSocket, deps: ConnectionDeps): void {
  const timeoutMs = deps.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
  let closed = false;
  let running = false;
  let controller: AbortController | undefined;
  let activeDispatchManager: DispatchManager | undefined;
  let requestCounter = 0;
  let activeRunId: string | undefined;
  let activeWorkspace: string | undefined;
  // requestId -> settle(result); settling clears its timeout and unregisters.
  // The result is the core ConfirmResult so "allow for session" can grow the
  // run's session allowlist ({ allow: true, remember: "session" }).
  const pending = new Map<string, (result: ConfirmResult) => void>();
  // question id -> settle(answer); same lifecycle as `pending`.
  const pendingQuestions = new Map<string, (answer: string) => void>();
  const subscriptions = new Map<string, RunSubscription>();

  // Connection-level errors (protocol violations, invalid UTF-8, oversized
  // frames, async send failures) are emitted as an "error" event; without a
  // listener the EventEmitter rethrows and crashes the whole server process.
  // They are non-fatal to us — the "close" event that follows drives cleanup.
  ws.on("error", () => {});

  const send = (frame: ServerFrame): void => {
    // Pass a callback so an async send failure surfaces as the (ignored) "error"
    // event above rather than an unhandled emitter throw.
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame), () => {});
  };
  const sendRun = (runId: string, workspace: string, frame: ServerFrame): void => {
    const eventType = frame.type === "event" ? (frame.event as { type?: unknown }).type : undefined;
    const loopEventType = frame.type === "loop.event" ? (frame.event as { type?: unknown }).type : undefined;
    const terminal =
      frame.type === "error" ||
      eventType === "session.completed" ||
      eventType === "session.failed" ||
      loopEventType === "loop.done";
    const stored = deps.runManager.appendFrame(workspace, runId, frame as unknown as Record<string, unknown>, {
      cacheSequence: !terminal,
    });
    send({ ...frame, runId, seq: stored.seq } as unknown as ServerFrame);
  };
  const fail = (code: string, message: string): void => send({ type: "error", code: code as ApiErrorCode, message });
  const launch = (operation: Promise<void>): void => {
    const tracked = deps.trackOperation?.(operation) ?? operation;
    void tracked.catch(() => {});
  };
  const terminalFrame = (frame: Record<string, unknown>): boolean => {
    if (frame["type"] === "error") return true;
    if (frame["type"] === "event" && typeof frame["event"] === "object" && frame["event"] !== null) {
      const type = (frame["event"] as { type?: unknown }).type;
      return type === "session.completed" || type === "session.failed";
    }
    return (
      frame["type"] === "loop.event" &&
      typeof frame["event"] === "object" &&
      frame["event"] !== null &&
      (frame["event"] as { type?: unknown }).type === "loop.done"
    );
  };
  const stopSubscription = (key: string): void => {
    const subscription = subscriptions.get(key);
    if (!subscription) return;
    if (subscription.timer) clearInterval(subscription.timer);
    subscription.unsubscribe?.();
    subscriptions.delete(key);
  };
  const deliverSubscriptionEvent = (key: string, subscription: RunSubscription, event: RunEvent): void => {
    if (event.seq <= subscription.afterSeq) return;
    send({ ...event.frame, runId: subscription.runId, seq: event.seq } as unknown as ServerFrame);
    subscription.afterSeq = event.seq;
    if (terminalFrame(event.frame)) stopSubscription(key);
  };
  const drainSubscription = (key: string, subscription: RunSubscription): boolean => {
    const page = deps.runManager.eventPage(subscription.workspace, subscription.runId, subscription.afterSeq);
    for (const event of page.events) {
      deliverSubscriptionEvent(key, subscription, event);
      if (!subscriptions.has(key)) return false;
    }
    subscription.catchingUp = page.hasMore;
    if (!page.hasMore) {
      const pending = subscription.pendingLocal.splice(0).sort((a, b) => a.event.seq - b.event.seq);
      for (const { event, identity } of pending) {
        subscription.fileIdentity = identity;
        deliverSubscriptionEvent(key, subscription, event);
        if (!subscriptions.has(key)) return false;
      }
    }
    return page.hasMore;
  };
  const pollSubscription = (key: string, subscription: RunSubscription, force = false): void => {
    try {
      if (subscriptions.get(key) !== subscription) return;
      const identity = deps.runManager.eventFileIdentity(subscription.workspace, subscription.runId);
      if (!force && identity === subscription.fileIdentity) return;
      subscription.fileIdentity = identity;
      if (drainSubscription(key, subscription) && subscriptions.has(key)) {
        setImmediate(() => pollSubscription(key, subscription, true));
      }
    } catch {
      stopSubscription(key);
      fail("internal_error", "run subscription failed");
    }
  };
  send({
    type: "hello",
    protocolVersion: SERVER_PROTOCOL_VERSION,
    capabilities: SERVER_CAPABILITIES,
    disconnectPolicy: "cancel",
    backgroundDisconnectPolicy: "continue",
  });

  // --- delta coalescing (see DELTA_FLUSH_MS) -------------------------------
  // At most one delta kind is buffered at a time; a coalesced frame is just a
  // normal model.delta/reasoning.delta event whose chunk is the concatenation,
  // so the frame schema is unchanged. CRITICAL ordering rule: anything that is
  // not a delta of the same kind (a structured event, a permission/question
  // request, a delta of the other kind) flushes the buffer FIRST, so clients
  // observe the exact event order the core produced.
  let pendingDeltaType: "model.delta" | "reasoning.delta" | undefined;
  let pendingDeltaChunk = "";
  let pendingDeltaSessionId = "";
  let deltaTimer: NodeJS.Timeout | undefined;

  const clearDeltaTimer = (): void => {
    if (deltaTimer !== undefined) {
      clearTimeout(deltaTimer);
      deltaTimer = undefined;
    }
  };

  /** Sends the buffered delta (if any) as one frame; always clears the timer. */
  const flushDeltas = (): void => {
    clearDeltaTimer();
    if (pendingDeltaType === undefined) return;
    const event = { type: pendingDeltaType, chunk: pendingDeltaChunk };
    pendingDeltaType = undefined;
    pendingDeltaChunk = "";
    const frame: ServerFrame = { type: "event", sessionId: pendingDeltaSessionId, event };
    if (activeRunId && activeWorkspace) sendRun(activeRunId, activeWorkspace, frame);
    else send(frame);
  };

  const bufferDelta = (type: "model.delta" | "reasoning.delta", sessionId: string, chunk: string): void => {
    // A kind or session switch flushes first, preserving cross-kind order.
    if (pendingDeltaType !== undefined && (pendingDeltaType !== type || pendingDeltaSessionId !== sessionId)) {
      flushDeltas();
    }
    pendingDeltaType = type;
    pendingDeltaSessionId = sessionId;
    pendingDeltaChunk += chunk;
    if (deltaTimer === undefined) deltaTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS);
  };

  const denyAllPending = (): void => {
    for (const settle of [...pending.values()]) settle(false);
    for (const settle of [...pendingQuestions.values()]) settle(DECLINED_ANSWER);
  };

  const confirm = (request: PermissionRequest): Promise<ConfirmResult> =>
    new Promise<ConfirmResult>((resolve) => {
      if (closed) {
        resolve(false);
        return;
      }
      const requestId = `p${++requestCounter}`;
      let timer: NodeJS.Timeout | undefined;
      const settle = (result: ConfirmResult) => {
        if (timer !== undefined) clearTimeout(timer);
        pending.delete(requestId);
        resolve(result);
      };
      timer = setTimeout(() => settle(false), timeoutMs);
      pending.set(requestId, settle);
      flushDeltas(); // buffered text must render before the permission prompt
      if (activeRunId && activeWorkspace)
        sendRun(activeRunId, activeWorkspace, { type: "permission.request", requestId, request });
      else send({ type: "permission.request", requestId, request });
    });

  /** ask_user bridge, mirroring `confirm`: timeout/disconnect = declined. */
  const askUser = (q: { question: string; options: string[] }): Promise<string> =>
    new Promise<string>((resolve) => {
      if (closed) {
        resolve(DECLINED_ANSWER);
        return;
      }
      const id = `q${++requestCounter}`;
      let timer: NodeJS.Timeout | undefined;
      const settle = (answer: string) => {
        if (timer !== undefined) clearTimeout(timer);
        pendingQuestions.delete(id);
        resolve(answer);
      };
      timer = setTimeout(() => settle(DECLINED_ANSWER), timeoutMs);
      pendingQuestions.set(id, settle);
      flushDeltas(); // buffered text must render before the question prompt
      if (activeRunId && activeWorkspace)
        sendRun(activeRunId, activeWorkspace, {
          type: "question.request",
          id,
          question: q.question,
          options: q.options,
        });
      else send({ type: "question.request", id, question: q.question, options: q.options });
    });

  const reserve = (
    runId: string,
    workspace: string,
    operation: (runController: AbortController) => Promise<void>,
    serialize: boolean,
  ): void => {
    running = true;
    const runController = new AbortController();
    controller = runController;
    activeRunId = runId;
    activeWorkspace = workspace;
    deps.runManager.start(runId, workspace, runController);
    const execute = () => operation(runController);
    launch(
      serialize && deps.withAgentMutation
        ? deps.withAgentMutation(workspace, runController.signal, execute)
        : serialize && deps.withRepository
          ? deps.withRepository(workspace, execute)
          : execute(),
    );
  };

  const run = async (runId: string, input: RunInput, runController: AbortController): Promise<void> => {
    const dispatchManager = createDispatchManager();
    activeDispatchManager = dispatchManager;
    let sessionId = input.resumeSessionId ?? "";
    // createAgent is built INSIDE the try: if it (or resolveOutputStyle) throws,
    // the finally still resets `running`, drains pending prompts, and sends idle
    // — otherwise the connection would wedge with running=true forever.
    let handle: Awaited<ReturnType<typeof deps.createAgent>> | undefined;
    let terminalStatus: RunStatus | undefined;
    try {
      runController.signal.throwIfAborted();
      // Inline thinking triggers ("think hard" / "ultrathink") raise the effort
      // for this turn, on top of (winning over) any frame overrides.
      const effort = detectThinkingKeyword(input.task);
      const overrides = effort ? { ...input.overrides, thinking: true, reasoningEffort: effort } : input.overrides;
      handle = await deps.createAgent({
        workspace: input.workspace,
        confirm,
        askUser,
        onModelDelta: (chunk) => bufferDelta("model.delta", sessionId, chunk),
        onReasoningDelta: (chunk) => bufferDelta("reasoning.delta", sessionId, chunk),
        extractMemory: input.mode === "edit",
        dispatchManager,
        signal: runController.signal,
        ...(overrides ? { overrides } : {}),
      });
      // An output-style override resolves to a system-prompt addendum; an unknown
      // style name is ignored (run with the base prompt) rather than failing.
      let appendSystemPrompt: string | undefined;
      if (overrides?.outputStyle) {
        try {
          appendSystemPrompt = resolveOutputStyle(overrides.outputStyle, input.workspace);
        } catch {
          appendSystemPrompt = undefined;
        }
      }
      const expandedTask = handle.expandTask ? await handle.expandTask(input.task, runController.signal) : input.task;
      for await (const event of handle.agent.runTask({
        projectPath: input.workspace,
        task: expandedTask,
        mode: input.mode,
        plan: input.plan,
        approvalMode: input.approvalMode,
        resumeSessionId: input.resumeSessionId,
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        signal: runController.signal,
      })) {
        if (event.type === "session.created") {
          sessionId = event.sessionId;
          deps.runManager.update(input.workspace, runId, { sessionId });
        } else if (event.type === "usage.updated") {
          deps.runManager.update(input.workspace, runId, { costUsd: event.usage.costUsd });
        } else if (event.type === "session.completed") {
          terminalStatus = "succeeded";
          deps.runManager.update(input.workspace, runId, {
            status: terminalStatus,
            costUsd: event.report.usage.costUsd,
          });
        } else if (event.type === "session.failed") {
          terminalStatus = event.error.code === "cancelled" ? "cancelled" : "failed";
          deps.runManager.update(input.workspace, runId, {
            status: terminalStatus,
            error: { code: event.error.code, message: event.error.message },
          });
        }
        flushDeltas(); // buffered deltas precede every structured event
        sendRun(runId, input.workspace, { type: "event", sessionId, event });
      }
    } catch (err) {
      // The core reports failures as session.failed events; this is a guard
      // against a misbehaving (e.g. injected) agent implementation.
      flushDeltas(); // buffered deltas precede the error frame
      const message = err instanceof Error ? err.message : String(err);
      terminalStatus = runController.signal.aborted ? "cancelled" : "failed";
      deps.runManager.update(input.workspace, runId, {
        status: terminalStatus,
        error: { code: terminalStatus === "cancelled" ? "cancelled" : "agent_error", message },
      });
      sendRun(runId, input.workspace, {
        type: "error",
        code: terminalStatus === "cancelled" ? "cancelled" : "agent_error",
        message,
      });
    } finally {
      try {
        handle?.dispose();
      } catch {
        // Disposal is best-effort; connection state must still be released.
      } finally {
        flushDeltas(); // don't lose a trailing chunk; also clears the timer
        running = false;
        if (controller === runController) controller = undefined;
        if (terminalStatus === undefined) {
          terminalStatus = "failed";
          deps.runManager.update(input.workspace, runId, {
            status: terminalStatus,
            error: { code: "incomplete", message: "agent run ended without a terminal event" },
          });
        }
        activeRunId = undefined;
        activeWorkspace = undefined;
        if (activeDispatchManager === dispatchManager) activeDispatchManager = undefined;
        denyAllPending();
        if (!closed) send({ type: "idle" });
      }
    }
  };

  const loop = async (
    runId: string,
    input: {
      workspace: string;
      task: string;
      verifyCommand: string;
      maxIterations?: number;
      budget?: number;
      requirementMode?: "quick" | "analyze" | "confirm";
      overrides?: RunOverrides;
    },
    runController: AbortController,
  ): Promise<void> => {
    try {
      runController.signal.throwIfAborted();
      const result = await deps.runLoop(
        {
          workspace: input.workspace,
          confirm,
          askUser,
          // Per-loop model/thinking overrides (from the run-toolbar) win over
          // config, just like a normal run.
          ...(input.overrides ? { overrides: input.overrides } : {}),
          // Loop progress is reported via loop.event (the desktop Loop panel).
          // The inner runs' streaming text/structured events are NOT forwarded
          // as `event` frames — doing so would push partial, never-finalized
          // assistant bubbles into the chat transcript (the finalizing
          // session/message events are consumed inside runAutoLoop).
          extractMemory: true,
        },
        {
          workspace: input.workspace,
          task: input.task,
          verifyCommand: input.verifyCommand,
          ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
          ...(input.budget !== undefined ? { costBudgetUsd: input.budget } : {}),
          ...(input.requirementMode !== undefined ? { requirementMode: input.requirementMode } : {}),
          approvalMode: "acceptEdits",
          signal: runController.signal,
          onEvent: (event) => sendRun(runId, input.workspace, { type: "loop.event", event }),
        },
      );
      deps.runManager.update(input.workspace, runId, {
        status:
          result.status === "cancelled"
            ? "cancelled"
            : result.status === "passed"
              ? "succeeded"
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
      const message = err instanceof Error ? err.message : String(err);
      deps.runManager.update(input.workspace, runId, {
        status: runController.signal.aborted ? "cancelled" : "failed",
        error: { code: runController.signal.aborted ? "cancelled" : "loop_error", message },
      });
      sendRun(runId, input.workspace, {
        type: "error",
        code: runController.signal.aborted ? "cancelled" : "loop_error",
        message,
      });
    } finally {
      running = false;
      if (controller === runController) controller = undefined;
      activeRunId = undefined;
      activeWorkspace = undefined;
      denyAllPending();
      if (!closed) send({ type: "idle" });
    }
  };

  const resumeLoop = async (
    runId: string,
    input: {
      workspace: string;
      loopId: string;
      addedIterations?: number;
      addedBudget?: number;
      approveRequirements?: boolean;
      overrides?: RunOverrides;
    },
    runController: AbortController,
  ): Promise<void> => {
    try {
      runController.signal.throwIfAborted();
      const result = await deps.resumeLoop(
        {
          workspace: input.workspace,
          confirm,
          askUser,
          ...(input.overrides ? { overrides: input.overrides } : {}),
          extractMemory: true,
        },
        input.loopId,
        {
          workspace: input.workspace,
          ...(input.addedIterations !== undefined ? { additionalIterations: input.addedIterations } : {}),
          ...(input.addedBudget !== undefined ? { additionalCostBudgetUsd: input.addedBudget } : {}),
          ...(input.approveRequirements !== undefined ? { approveRequirements: input.approveRequirements } : {}),
          approvalMode: "acceptEdits",
          signal: runController.signal,
          onEvent: (event) => sendRun(runId, input.workspace, { type: "loop.event", event }),
        },
      );
      deps.runManager.update(input.workspace, runId, {
        status:
          result.status === "cancelled"
            ? "cancelled"
            : result.status === "passed"
              ? "succeeded"
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
      const message = err instanceof Error ? err.message : String(err);
      deps.runManager.update(input.workspace, runId, {
        status: runController.signal.aborted ? "cancelled" : "failed",
        error: { code: runController.signal.aborted ? "cancelled" : "loop_error", message },
      });
      sendRun(runId, input.workspace, {
        type: "error",
        code: runController.signal.aborted ? "cancelled" : "loop_error",
        message,
      });
    } finally {
      running = false;
      if (controller === runController) controller = undefined;
      activeRunId = undefined;
      activeWorkspace = undefined;
      denyAllPending();
      if (!closed) send({ type: "idle" });
    }
  };

  ws.on("message", (data: RawData) => {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      frame = parsed as Record<string, unknown>;
    } catch {
      fail("bad_frame", "frames must be JSON objects with a type field");
      return;
    }

    switch (frame["type"]) {
      case "start": {
        if (running) return fail("busy", "a session is already running on this connection");
        const { task, mode, approvalMode, plan, ws: wsId } = frame;
        if (typeof task !== "string" || task.trim().length === 0) {
          return fail("bad_frame", "start.task must be a non-empty string");
        }
        if (mode !== "edit" && mode !== "ask") {
          return fail("bad_frame", 'start.mode must be "edit" or "ask"');
        }
        if (approvalMode !== "auto" && approvalMode !== "acceptEdits" && approvalMode !== "confirm") {
          return fail("bad_frame", 'start.approvalMode must be "auto", "acceptEdits", or "confirm"');
        }
        if (plan !== undefined && typeof plan !== "boolean") {
          return fail("bad_frame", "start.plan must be a boolean when present");
        }
        if (wsId !== undefined && typeof wsId !== "string") {
          return fail("bad_frame", "start.ws must be a string when present");
        }
        const parsed = parseRunOverrides(frame);
        if ("error" in parsed) return fail("bad_frame", `start.${parsed.error}`);
        // Omitted ws -> the default (first) workspace, preserving old clients.
        const workspace = deps.registry.resolve(wsId);
        if (!workspace) return fail("unknown_workspace", `unknown workspace: ${String(wsId)}`);
        const ledgerRun = deps.runManager.create({ workspace: workspace.path, source: "ws" });
        sendRun(ledgerRun.runId, workspace.path, { type: "run.accepted", runId: ledgerRun.runId, status: "queued" });
        // plan is passed through as-is (the UI sends mode:"ask" + plan:true).
        reserve(
          ledgerRun.runId,
          workspace.path,
          (runController) =>
            run(
              ledgerRun.runId,
              { task, mode, approvalMode, plan, workspace: workspace.path, ...parsed },
              runController,
            ),
          mode === "edit",
        );
        return;
      }

      case "send": {
        if (running) return fail("busy", "a session is already running on this connection");
        const { sessionId, task, mode, approvalMode, ws: wsId } = frame;
        if (typeof sessionId !== "string" || typeof task !== "string" || task.trim().length === 0) {
          return fail("bad_frame", "send needs sessionId and a non-empty task");
        }
        if (mode !== undefined && mode !== "edit" && mode !== "ask") {
          return fail("bad_frame", 'send.mode must be "edit" or "ask" when present');
        }
        if (
          approvalMode !== undefined &&
          approvalMode !== "auto" &&
          approvalMode !== "acceptEdits" &&
          approvalMode !== "confirm"
        ) {
          return fail("bad_frame", 'send.approvalMode must be "auto", "acceptEdits", or "confirm" when present');
        }
        if (wsId !== undefined && typeof wsId !== "string") {
          return fail("bad_frame", "send.ws must be a string when present");
        }
        const parsed = parseRunOverrides(frame);
        if ("error" in parsed) return fail("bad_frame", `send.${parsed.error}`);
        const workspace = deps.registry.resolve(wsId);
        if (!workspace) return fail("unknown_workspace", `unknown workspace: ${String(wsId)}`);
        // isSafeId keeps a traversal-shaped id from ever reaching the session
        // store (same predicate the REST session routes use).
        const meta = isSafeId(sessionId) ? readSessionMeta(workspace.path, sessionId) : undefined;
        if (!meta) return fail("unknown_session", `session not found: ${sessionId}`);
        const ledgerRun = deps.runManager.create({
          workspace: workspace.path,
          source: "ws",
          labels: { resumedSessionId: sessionId },
        });
        sendRun(ledgerRun.runId, workspace.path, { type: "run.accepted", runId: ledgerRun.runId, status: "queued" });
        // A resumed session keeps its original ask/edit mode unless the frame
        // overrides it (plan -> execute). Approvals default to interactive
        // ("confirm") but the client may change them per follow-up message.
        reserve(
          ledgerRun.runId,
          workspace.path,
          (runController) =>
            run(
              ledgerRun.runId,
              {
                task,
                mode: mode ?? meta.mode,
                approvalMode: (approvalMode as ApprovalMode | undefined) ?? "confirm",
                resumeSessionId: sessionId,
                workspace: workspace.path,
                ...parsed,
              },
              runController,
            ),
          (mode ?? meta.mode) === "edit",
        );
        return;
      }

      case "loop": {
        if (running) return fail("busy", "a session is already running on this connection");
        const { task, verifyCommand, maxIterations, budget, requirementMode, ws: wsId } = frame;
        if (typeof task !== "string" || task.trim().length === 0) {
          return fail("bad_frame", "loop.task must be a non-empty string");
        }
        if (typeof verifyCommand !== "string" || verifyCommand.trim().length === 0) {
          return fail("bad_frame", "loop.verifyCommand must be a non-empty string");
        }
        if (
          maxIterations !== undefined &&
          (typeof maxIterations !== "number" ||
            !Number.isInteger(maxIterations) ||
            maxIterations <= 0 ||
            maxIterations > MAX_LOOP_ITERATIONS)
        ) {
          return fail("bad_frame", `loop.maxIterations must be an integer from 1 to ${MAX_LOOP_ITERATIONS}`);
        }
        if (budget !== undefined && (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0)) {
          return fail("bad_frame", "loop.budget must be a finite positive number when present");
        }
        if (
          requirementMode !== undefined &&
          requirementMode !== "quick" &&
          requirementMode !== "analyze" &&
          requirementMode !== "confirm"
        ) {
          return fail("bad_frame", 'loop.requirementMode must be "quick", "analyze", or "confirm"');
        }
        if (wsId !== undefined && typeof wsId !== "string") {
          return fail("bad_frame", "loop.ws must be a string when present");
        }
        const parsedOverrides = parseRunOverrides(frame);
        if ("error" in parsedOverrides) return fail("bad_frame", `loop.${parsedOverrides.error}`);
        const workspace = deps.registry.resolve(wsId);
        if (!workspace) return fail("unknown_workspace", `unknown workspace: ${String(wsId)}`);
        const ledgerRun = deps.runManager.create({ workspace: workspace.path, source: "loop" });
        sendRun(ledgerRun.runId, workspace.path, { type: "run.accepted", runId: ledgerRun.runId, status: "queued" });
        reserve(
          ledgerRun.runId,
          workspace.path,
          (runController) =>
            loop(
              ledgerRun.runId,
              {
                workspace: workspace.path,
                task,
                verifyCommand,
                ...(maxIterations !== undefined ? { maxIterations } : {}),
                ...(budget !== undefined ? { budget } : {}),
                ...(requirementMode !== undefined ? { requirementMode } : {}),
                ...(parsedOverrides.overrides ? { overrides: parsedOverrides.overrides } : {}),
              },
              runController,
            ),
          true,
        );
        return;
      }

      case "loop.resume": {
        if (running) return fail("busy", "a session is already running on this connection");
        const { loopId, addedIterations, addedBudget, approveRequirements, ws: wsId } = frame;
        if (typeof loopId !== "string" || !isValidLoopId(loopId)) {
          return fail("bad_frame", "loop.resume.loopId must be a safe non-empty id");
        }
        if (
          addedIterations !== undefined &&
          (typeof addedIterations !== "number" ||
            !Number.isInteger(addedIterations) ||
            addedIterations <= 0 ||
            addedIterations > MAX_LOOP_ITERATIONS)
        ) {
          return fail("bad_frame", `loop.resume.addedIterations must be an integer from 1 to ${MAX_LOOP_ITERATIONS}`);
        }
        if (approveRequirements !== undefined && typeof approveRequirements !== "boolean") {
          return fail("bad_frame", "loop.resume.approveRequirements must be a boolean when present");
        }
        if (
          addedBudget !== undefined &&
          (typeof addedBudget !== "number" || !Number.isFinite(addedBudget) || addedBudget <= 0)
        ) {
          return fail("bad_frame", "loop.resume.addedBudget must be a finite positive number when present");
        }
        if (wsId !== undefined && typeof wsId !== "string") {
          return fail("bad_frame", "loop.resume.ws must be a string when present");
        }
        const parsedOverrides = parseRunOverrides(frame);
        if ("error" in parsedOverrides) return fail("bad_frame", `loop.resume.${parsedOverrides.error}`);
        const workspace = deps.registry.resolve(wsId);
        if (!workspace) return fail("unknown_workspace", `unknown workspace: ${String(wsId)}`);
        const ledgerRun = deps.runManager.create({ workspace: workspace.path, source: "loop", labels: { loopId } });
        sendRun(ledgerRun.runId, workspace.path, { type: "run.accepted", runId: ledgerRun.runId, status: "queued" });
        reserve(
          ledgerRun.runId,
          workspace.path,
          (runController) =>
            resumeLoop(
              ledgerRun.runId,
              {
                workspace: workspace.path,
                loopId,
                ...(addedIterations !== undefined ? { addedIterations } : {}),
                ...(addedBudget !== undefined ? { addedBudget } : {}),
                ...(approveRequirements !== undefined ? { approveRequirements } : {}),
                ...(parsedOverrides.overrides ? { overrides: parsedOverrides.overrides } : {}),
              },
              runController,
            ),
          true,
        );
        return;
      }

      case "permission.response": {
        const { requestId, approved, remember, selectedHunks } = frame;
        const settle = typeof requestId === "string" ? pending.get(requestId) : undefined;
        if (!settle) return fail("unknown_request", `no pending permission request: ${String(requestId)}`);
        const allow = approved === true;
        // selectedHunks: per-hunk selection for multi-hunk apply_patch calls.
        const validSelectedHunks =
          Array.isArray(selectedHunks) &&
          selectedHunks.length > 0 &&
          selectedHunks.length <= 10_000 &&
          selectedHunks.every((index) => Number.isSafeInteger(index) && index >= 0);
        if (allow && selectedHunks !== undefined && !validSelectedHunks) {
          settle(false);
        } else if (allow && validSelectedHunks) {
          settle({ allow: true, selectedHunks });
        } else if (allow && remember === "session") {
          // remember:"session" forwards the richer ConfirmResult so core grows
          // its session allowlist; a plain allow/deny stays a bare boolean.
          settle({ allow: true, remember: "session" });
        } else {
          settle(allow);
        }
        return;
      }

      case "question.answer": {
        const { id, answer } = frame;
        const settle = typeof id === "string" ? pendingQuestions.get(id) : undefined;
        if (!settle) return fail("unknown_request", `no pending question: ${String(id)}`);
        settle(typeof answer === "string" && answer.length > 0 ? answer : DECLINED_ANSWER);
        return;
      }

      case "subagent.cancel": {
        if (Object.keys(frame).some((key) => key !== "type" && key !== "dispatchId")) {
          return fail("bad_frame", "subagent.cancel accepts only dispatchId");
        }
        const { dispatchId } = frame;
        if (typeof dispatchId !== "string" || !/^ag-[1-9]\d*$/.test(dispatchId) || dispatchId.length > 64) {
          return fail("bad_frame", "subagent.cancel.dispatchId must be a valid dispatch id");
        }
        if (!running || !activeDispatchManager) {
          return fail("not_running", "no controllable agent run is active");
        }
        const result = activeDispatchManager.cancel(dispatchId);
        if (!result.ok) return fail(result.code, result.message);
        send({ type: "subagent.control", dispatchId, operation: "cancel", status: "accepted" });
        return;
      }

      case "subagent.steer": {
        if (Object.keys(frame).some((key) => key !== "type" && key !== "dispatchId" && key !== "message")) {
          return fail("bad_frame", "subagent.steer accepts only dispatchId and message");
        }
        const { dispatchId, message } = frame;
        if (typeof dispatchId !== "string" || !/^ag-[1-9]\d*$/.test(dispatchId) || dispatchId.length > 64) {
          return fail("bad_frame", "subagent.steer.dispatchId must be a valid dispatch id");
        }
        if (typeof message !== "string" || message.trim().length === 0 || message.length > MAX_STEER_MESSAGE_LENGTH) {
          return fail("bad_frame", `subagent.steer.message must contain 1-${MAX_STEER_MESSAGE_LENGTH} characters`);
        }
        if (!running || !activeDispatchManager) {
          return fail("not_running", "no controllable agent run is active");
        }
        const result = activeDispatchManager.steer(dispatchId, message);
        if (!result.ok) return fail(result.code, result.message);
        send({ type: "subagent.control", dispatchId, operation: "steer", status: "accepted" });
        return;
      }

      case "cancel": {
        if (!running || !controller) return fail("not_running", "no session is running");
        // Unblock a run paused on a permission prompt so it observes the abort.
        denyAllPending();
        if (activeRunId && activeWorkspace) deps.runManager.cancel(activeWorkspace, activeRunId);
        else controller.abort();
        return;
      }

      case "subscribe": {
        const { runId, afterSeq, ws: wsId } = frame;
        if (typeof runId !== "string" || !/^run-[A-Za-z0-9-]+$/.test(runId)) {
          return fail("bad_frame", "subscribe.runId must be a valid run id");
        }
        if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || (afterSeq as number) < 0)) {
          return fail("bad_frame", "subscribe.afterSeq must be a non-negative safe integer");
        }
        if (wsId !== undefined && typeof wsId !== "string") {
          return fail("bad_frame", "subscribe.ws must be a string when present");
        }
        const workspace = deps.registry.resolve(wsId);
        if (!workspace) return fail("unknown_workspace", `unknown workspace: ${String(wsId)}`);
        if (!deps.runManager.get(workspace.path, runId)) return fail("unknown_run", `run not found: ${runId}`);
        const key = `${workspace.path}\0${runId}`;
        const existing = subscriptions.get(key);
        if (existing) stopSubscription(key);
        const subscription: RunSubscription = {
          workspace: workspace.path,
          runId,
          afterSeq: (afterSeq as number | undefined) ?? 0,
          catchingUp: true,
          pendingLocal: [],
        };
        subscriptions.set(key, subscription);
        subscription.unsubscribe = deps.runManager.subscribeFrames(workspace.path, runId, (event, identity) => {
          try {
            if (subscription.catchingUp) subscription.pendingLocal.push({ event, identity });
            else {
              subscription.fileIdentity = identity;
              deliverSubscriptionEvent(key, subscription, event);
            }
          } catch {
            stopSubscription(key);
            fail("internal_error", "run subscription failed");
          }
        });
        pollSubscription(key, subscription, true);
        if (!subscriptions.has(key)) return;
        subscription.timer = setInterval(() => pollSubscription(key, subscription), SUBSCRIPTION_POLL_MS);
        subscription.timer.unref();
        return;
      }

      default:
        return fail("bad_frame", `unknown frame type: ${String(frame["type"])}`);
    }
  });

  ws.on("close", () => {
    closed = true;
    // Drop (not flush) any buffered delta — the socket is gone — and clear the
    // timer so nothing fires after close.
    clearDeltaTimer();
    pendingDeltaType = undefined;
    pendingDeltaChunk = "";
    for (const subscription of subscriptions.values()) {
      if (subscription.timer) clearInterval(subscription.timer);
      subscription.unsubscribe?.();
    }
    subscriptions.clear();
    denyAllPending();
    activeDispatchManager?.disposeAll();
    if (activeRunId && activeWorkspace) deps.runManager.cancel(activeWorkspace, activeRunId);
    else controller?.abort();
  });
}

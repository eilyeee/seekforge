/**
 * WebSocket protocol (/ws) — drives agent runs (SERVER-API.md).
 *
 * One connection drives at most one *running* session at a time (busy rule).
 * Permission requests pause the run until the matching permission.response,
 * a 120 s timeout, or socket close (both treated as denied). Socket close
 * while running aborts the run via AbortController.
 */

import type { RawData, WebSocket } from "ws";
import { readSessionMeta } from "@seekforge/core";
import type { AgentEvent, ApprovalMode, PermissionRequest } from "@seekforge/shared";
import type { CreateAgentFn } from "./agent.js";

export const PERMISSION_TIMEOUT_MS = 120_000;

/** Server-level event: model deltas streamed via the core's callback. */
type ModelDeltaEvent = { type: "model.delta"; chunk: string };

type ServerFrame =
  | { type: "event"; sessionId: string; event: AgentEvent | ModelDeltaEvent }
  | { type: "permission.request"; requestId: string; request: PermissionRequest }
  | { type: "error"; code: string; message: string }
  | { type: "idle" };

export type ConnectionDeps = {
  workspace: string;
  createAgent: CreateAgentFn;
  permissionTimeoutMs?: number;
};

type RunInput = {
  task: string;
  mode: "ask" | "edit";
  approvalMode: ApprovalMode;
  resumeSessionId?: string;
};

export function handleConnection(ws: WebSocket, deps: ConnectionDeps): void {
  const timeoutMs = deps.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
  let closed = false;
  let running = false;
  let controller: AbortController | undefined;
  let requestCounter = 0;
  // requestId -> settle(approved); settling clears its timeout and unregisters.
  const pending = new Map<string, (approved: boolean) => void>();

  const send = (frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const fail = (code: string, message: string): void => send({ type: "error", code, message });

  const denyAllPending = (): void => {
    for (const settle of [...pending.values()]) settle(false);
  };

  const confirm = (request: PermissionRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (closed) {
        resolve(false);
        return;
      }
      const requestId = `p${++requestCounter}`;
      let timer: NodeJS.Timeout | undefined;
      const settle = (approved: boolean) => {
        if (timer !== undefined) clearTimeout(timer);
        pending.delete(requestId);
        resolve(approved);
      };
      timer = setTimeout(() => settle(false), timeoutMs);
      pending.set(requestId, settle);
      send({ type: "permission.request", requestId, request });
    });

  const run = async (input: RunInput): Promise<void> => {
    running = true;
    controller = new AbortController();
    let sessionId = input.resumeSessionId ?? "";
    const handle = deps.createAgent({
      workspace: deps.workspace,
      confirm,
      onModelDelta: (chunk) => send({ type: "event", sessionId, event: { type: "model.delta", chunk } }),
      extractMemory: input.mode === "edit",
    });
    try {
      for await (const event of handle.agent.runTask({
        projectPath: deps.workspace,
        task: input.task,
        mode: input.mode,
        approvalMode: input.approvalMode,
        resumeSessionId: input.resumeSessionId,
        signal: controller.signal,
      })) {
        if (event.type === "session.created") sessionId = event.sessionId;
        send({ type: "event", sessionId, event });
      }
    } catch (err) {
      // The core reports failures as session.failed events; this is a guard
      // against a misbehaving (e.g. injected) agent implementation.
      fail("agent_error", err instanceof Error ? err.message : String(err));
    } finally {
      handle.dispose();
      running = false;
      controller = undefined;
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
        const { task, mode, approvalMode } = frame;
        if (typeof task !== "string" || task.length === 0) {
          return fail("bad_frame", "start.task must be a non-empty string");
        }
        if (mode !== "edit" && mode !== "ask") {
          return fail("bad_frame", 'start.mode must be "edit" or "ask"');
        }
        if (approvalMode !== "auto" && approvalMode !== "confirm") {
          return fail("bad_frame", 'start.approvalMode must be "auto" or "confirm"');
        }
        void run({ task, mode, approvalMode });
        return;
      }

      case "send": {
        if (running) return fail("busy", "a session is already running on this connection");
        const { sessionId, task } = frame;
        if (typeof sessionId !== "string" || typeof task !== "string" || task.length === 0) {
          return fail("bad_frame", "send needs sessionId and a non-empty task");
        }
        const meta =
          /[/\\]/.test(sessionId) || sessionId.includes("..")
            ? undefined
            : readSessionMeta(deps.workspace, sessionId);
        if (!meta) return fail("unknown_session", `session not found: ${sessionId}`);
        // A resumed session keeps its original ask/edit mode; approvals stay interactive.
        void run({ task, mode: meta.mode, approvalMode: "confirm", resumeSessionId: sessionId });
        return;
      }

      case "permission.response": {
        const { requestId, approved } = frame;
        const settle = typeof requestId === "string" ? pending.get(requestId) : undefined;
        if (!settle) return fail("unknown_request", `no pending permission request: ${String(requestId)}`);
        settle(approved === true);
        return;
      }

      case "cancel": {
        if (!running || !controller) return fail("not_running", "no session is running");
        // Unblock a run paused on a permission prompt so it observes the abort.
        denyAllPending();
        controller.abort();
        return;
      }

      default:
        return fail("bad_frame", `unknown frame type: ${String(frame["type"])}`);
    }
  });

  ws.on("close", () => {
    closed = true;
    denyAllPending();
    controller?.abort();
  });
}

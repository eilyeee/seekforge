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
import { readSessionMeta } from "@seekforge/core";
import type { AgentEvent, ApprovalMode, PermissionRequest } from "@seekforge/shared";
import type { CreateAgentFn } from "./agent.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const PERMISSION_TIMEOUT_MS = 120_000;

/** Answer reported to the core when the user never answers an ask_user question. */
export const DECLINED_ANSWER = "(the user declined to answer)";

/** Server-level events: model/reasoning deltas streamed via core callbacks. */
type ModelDeltaEvent = { type: "model.delta"; chunk: string };
type ReasoningDeltaEvent = { type: "reasoning.delta"; chunk: string };

type ServerFrame =
  | { type: "event"; sessionId: string; event: AgentEvent | ModelDeltaEvent | ReasoningDeltaEvent }
  | { type: "permission.request"; requestId: string; request: PermissionRequest }
  | { type: "question.request"; id: string; question: string; options: string[] }
  | { type: "error"; code: string; message: string }
  | { type: "idle" };

export type ConnectionDeps = {
  registry: WorkspaceRegistry;
  createAgent: CreateAgentFn;
  permissionTimeoutMs?: number;
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
};

export function handleConnection(ws: WebSocket, deps: ConnectionDeps): void {
  const timeoutMs = deps.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
  let closed = false;
  let running = false;
  let controller: AbortController | undefined;
  let requestCounter = 0;
  // requestId -> settle(approved); settling clears its timeout and unregisters.
  const pending = new Map<string, (approved: boolean) => void>();
  // question id -> settle(answer); same lifecycle as `pending`.
  const pendingQuestions = new Map<string, (answer: string) => void>();

  const send = (frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const fail = (code: string, message: string): void => send({ type: "error", code, message });

  const denyAllPending = (): void => {
    for (const settle of [...pending.values()]) settle(false);
    for (const settle of [...pendingQuestions.values()]) settle(DECLINED_ANSWER);
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
      send({ type: "question.request", id, question: q.question, options: q.options });
    });

  const run = async (input: RunInput): Promise<void> => {
    running = true;
    controller = new AbortController();
    let sessionId = input.resumeSessionId ?? "";
    const handle = deps.createAgent({
      workspace: input.workspace,
      confirm,
      askUser,
      onModelDelta: (chunk) => send({ type: "event", sessionId, event: { type: "model.delta", chunk } }),
      onReasoningDelta: (chunk) => send({ type: "event", sessionId, event: { type: "reasoning.delta", chunk } }),
      extractMemory: input.mode === "edit",
    });
    try {
      for await (const event of handle.agent.runTask({
        projectPath: input.workspace,
        task: input.task,
        mode: input.mode,
        plan: input.plan,
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
        const { task, mode, approvalMode, plan, ws: wsId } = frame;
        if (typeof task !== "string" || task.length === 0) {
          return fail("bad_frame", "start.task must be a non-empty string");
        }
        if (mode !== "edit" && mode !== "ask") {
          return fail("bad_frame", 'start.mode must be "edit" or "ask"');
        }
        if (approvalMode !== "auto" && approvalMode !== "confirm") {
          return fail("bad_frame", 'start.approvalMode must be "auto" or "confirm"');
        }
        if (plan !== undefined && typeof plan !== "boolean") {
          return fail("bad_frame", "start.plan must be a boolean when present");
        }
        if (wsId !== undefined && typeof wsId !== "string") {
          return fail("bad_frame", "start.ws must be a string when present");
        }
        // Omitted ws -> the default (first) workspace, preserving old clients.
        const workspace = deps.registry.resolve(wsId);
        if (!workspace) return fail("unknown_workspace", `unknown workspace: ${String(wsId)}`);
        // plan is passed through as-is (the UI sends mode:"ask" + plan:true).
        void run({ task, mode, approvalMode, plan, workspace: workspace.path });
        return;
      }

      case "send": {
        if (running) return fail("busy", "a session is already running on this connection");
        const { sessionId, task, mode, ws: wsId } = frame;
        if (typeof sessionId !== "string" || typeof task !== "string" || task.length === 0) {
          return fail("bad_frame", "send needs sessionId and a non-empty task");
        }
        if (mode !== undefined && mode !== "edit" && mode !== "ask") {
          return fail("bad_frame", 'send.mode must be "edit" or "ask" when present');
        }
        if (wsId !== undefined && typeof wsId !== "string") {
          return fail("bad_frame", "send.ws must be a string when present");
        }
        const workspace = deps.registry.resolve(wsId);
        if (!workspace) return fail("unknown_workspace", `unknown workspace: ${String(wsId)}`);
        const meta =
          /[/\\]/.test(sessionId) || sessionId.includes("..")
            ? undefined
            : readSessionMeta(workspace.path, sessionId);
        if (!meta) return fail("unknown_session", `session not found: ${sessionId}`);
        // A resumed session keeps its original ask/edit mode unless the frame
        // overrides it (plan -> execute); approvals stay interactive.
        void run({
          task,
          mode: mode ?? meta.mode,
          approvalMode: "confirm",
          resumeSessionId: sessionId,
          workspace: workspace.path,
        });
        return;
      }

      case "permission.response": {
        const { requestId, approved } = frame;
        const settle = typeof requestId === "string" ? pending.get(requestId) : undefined;
        if (!settle) return fail("unknown_request", `no pending permission request: ${String(requestId)}`);
        settle(approved === true);
        return;
      }

      case "question.answer": {
        const { id, answer } = frame;
        const settle = typeof id === "string" ? pendingQuestions.get(id) : undefined;
        if (!settle) return fail("unknown_request", `no pending question: ${String(id)}`);
        settle(typeof answer === "string" && answer.length > 0 ? answer : DECLINED_ANSWER);
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

/** WS frame types per SERVER-API.md (the binding contract). */
import type { PermissionRequest } from "@seekforge/shared";
import type { StreamEvent } from "./events";
import type { LoopEvent } from "../types";

/** Per-run model/thinking overrides (win over server config for that run only). */
export type RunOverrides = {
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
};

export type ClientFrame =
  | ({
      type: "start";
      task: string;
      mode: "edit" | "ask";
      approvalMode: "auto" | "acceptEdits" | "confirm";
      plan?: boolean;
      /** Workspace id (default: first workspace when omitted). */
      ws?: string;
    } & RunOverrides)
  | ({
      type: "send";
      sessionId: string;
      task: string;
      /** edit/ask switchable per follow-up; absent keeps the session's mode. */
      mode?: "edit" | "ask";
      /** Approval mode can change between turns; absent defaults to "confirm". */
      approvalMode?: "auto" | "acceptEdits" | "confirm";
      ws?: string;
    } & RunOverrides)
  | {
      type: "permission.response";
      requestId: string;
      approved: boolean;
      /** "session" = allow this (and similar) for the rest of the session. */
      remember?: "session";
      /** Per-hunk selection for multi-hunk apply_patch calls. */
      selectedHunks?: number[];
    }
  | { type: "question.answer"; id: string; answer: string }
  | ({
      /**
       * Loop mode: run the task, then `verifyCommand`; if it fails, keep fixing
       * and re-running until it passes — autonomously (the server forces
       * acceptEdits), within the iteration/budget limits. Streamed back as
       * `loop.event` frames; the existing `cancel` frame stops it. model/
       * thinking/reasoningEffort overrides (from the run-toolbar) ride along.
       */
      type: "loop";
      task: string;
      verifyCommand: string;
      /** Hard cap on run→verify cycles (server default when omitted). */
      maxIterations?: number;
      /** Optional total USD budget; the loop stops once exceeded. */
      budget?: number;
      ws?: string;
    } & RunOverrides)
  | { type: "cancel" };

export type ServerFrame =
  | { type: "event"; sessionId: string; event: StreamEvent }
  | { type: "permission.request"; requestId: string; request: PermissionRequest }
  | { type: "question.request"; id: string; question: string; options: string[] }
  | { type: "loop.event"; event: LoopEvent }
  | { type: "error"; code: string; message: string }
  | { type: "idle" };

export type ConnState = "disconnected" | "connecting" | "connected";

export type WsClientHandlers = {
  onFrame: (frame: ServerFrame) => void;
  onState: (state: ConnState) => void;
};

export type WsClient = {
  send: (frame: ClientFrame) => void;
  close: () => void;
};

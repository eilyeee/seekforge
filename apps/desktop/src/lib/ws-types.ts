/** WS frame types per SERVER-API.md (the binding contract). */
import type { PermissionRequest } from "@seekforge/shared";
import type { StreamEvent } from "./events";

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
      approvalMode: "auto" | "confirm";
      plan?: boolean;
      /** Workspace id (default: first workspace when omitted). */
      ws?: string;
    } & RunOverrides)
  | ({ type: "send"; sessionId: string; task: string; mode?: "edit"; ws?: string } & RunOverrides)
  | { type: "permission.response"; requestId: string; approved: boolean }
  | { type: "question.answer"; id: string; answer: string }
  | { type: "cancel" };

export type ServerFrame =
  | { type: "event"; sessionId: string; event: StreamEvent }
  | { type: "permission.request"; requestId: string; request: PermissionRequest }
  | { type: "question.request"; id: string; question: string; options: string[] }
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

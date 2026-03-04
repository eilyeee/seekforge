/** WS frame types per SERVER-API.md (the binding contract). */
import type { PermissionRequest } from "@seekforge/shared";
import type { StreamEvent } from "./events";

export type ClientFrame =
  | { type: "start"; task: string; mode: "edit" | "ask"; approvalMode: "auto" | "confirm" }
  | { type: "send"; sessionId: string; task: string }
  | { type: "permission.response"; requestId: string; approved: boolean }
  | { type: "cancel" };

export type ServerFrame =
  | { type: "event"; sessionId: string; event: StreamEvent }
  | { type: "permission.request"; requestId: string; request: PermissionRequest }
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

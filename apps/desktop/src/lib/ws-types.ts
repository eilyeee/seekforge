/**
 * WS frame types per SERVER-API.md — re-exported from @seekforge/shared (the
 * SINGLE SOURCE OF TRUTH). The frame unions used to be hand-mirrored here; they
 * now live in @seekforge/shared so server + desktop share ONE definition. The
 * desktop-only WS *client* helper types stay local below.
 */
import type { ClientFrame, ServerFrame as SharedServerFrame } from "@seekforge/shared";

export type { RunOverrides, ClientFrame } from "@seekforge/shared";

export type ServerFrame = SharedServerFrame | {
  type: "subagent.control";
  dispatchId: string;
  operation: "steer" | "cancel";
  status: "accepted";
};

export type ConnState = "disconnected" | "connecting" | "connected";

export type WsClientHandlers = {
  onFrame: (frame: ServerFrame) => void;
  onState: (state: ConnState) => void;
};

export type WsClient = {
  /** True when sent now or accepted by the initial connection queue. */
  send: (frame: ClientFrame) => boolean;
  close: () => void;
};

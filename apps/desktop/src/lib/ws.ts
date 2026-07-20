/** WebSocket client with exponential-backoff reconnect. */
import { isMock } from "../mock";
import { MAX_WS_PAYLOAD_BYTES } from "@seekforge/shared/protocol-limits";
import { createMockWs } from "../mock/ws";
import type { ClientFrame, ConnState, WsClient, WsClientHandlers } from "./ws-types";

export type { ClientFrame, ConnState, ServerFrame, WsClient } from "./ws-types";

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;

export function encodeClientFrame(frame: ClientFrame): string | null {
  const payload = JSON.stringify(frame);
  return new TextEncoder().encode(payload).byteLength <= MAX_WS_PAYLOAD_BYTES ? payload : null;
}

export function createWsClient(handlers: WsClientHandlers & { getToken: () => string }): WsClient {
  if (isMock()) return createMockWs(handlers);

  let sock: WebSocket | null = null;
  let attempts = 0;
  let closed = false;
  let initialConnection = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: string[] = [];

  const wsUrl = () => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const token = handlers.getToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${proto}://${window.location.host}/ws${qs}`;
  };

  const setState = (s: ConnState) => handlers.onState(s);

  function flush() {
    while (queue.length > 0 && sock && sock.readyState === WebSocket.OPEN) {
      sock.send(queue.shift() as string);
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closed) return;
    setState("connecting");
    const connection = new WebSocket(wsUrl());
    sock = connection;
    connection.onopen = () => {
      if (closed || sock !== connection) {
        connection.close();
        return;
      }
      initialConnection = false;
      attempts = 0;
      setState("connected");
      flush();
    };
    connection.onmessage = (e) => {
      if (closed || sock !== connection) return;
      try {
        handlers.onFrame(JSON.parse(String(e.data)));
      } catch {
        // ignore malformed frames
      }
    };
    connection.onclose = () => {
      if (sock !== connection) return;
      sock = null;
      initialConnection = false;
      if (closed) return;
      // Requests queued for this failed connection were marked interrupted by
      // the store. Never replay them silently on a later connection.
      queue.length = 0;
      setState("disconnected");
      scheduleReconnect();
    };
    connection.onerror = () => {
      connection.close();
    };
  }

  connect();

  return {
    send(frame: ClientFrame) {
      const payload = encodeClientFrame(frame);
      if (payload === null) return false;
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(payload);
        return true;
      }
      if (initialConnection && sock) {
        queue.push(payload);
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      queue.length = 0;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sock?.close();
      setState("disconnected");
    },
  };
}

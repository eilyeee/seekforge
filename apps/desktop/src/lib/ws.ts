/** WebSocket client with exponential-backoff reconnect. */
import { isMock } from "../mock";
import { createMockWs } from "../mock/ws";
import type { ClientFrame, ConnState, WsClient, WsClientHandlers } from "./ws-types";

export type { ClientFrame, ConnState, ServerFrame, WsClient } from "./ws-types";

const MAX_BACKOFF_MS = 8000;
const BASE_BACKOFF_MS = 500;

export function createWsClient(handlers: WsClientHandlers & { getToken: () => string }): WsClient {
  if (isMock()) return createMockWs(handlers);

  let sock: WebSocket | null = null;
  let attempts = 0;
  let closed = false;
  let initialConnection = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: ClientFrame[] = [];

  const wsUrl = () => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const token = handlers.getToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${proto}://${window.location.host}/ws${qs}`;
  };

  const setState = (s: ConnState) => handlers.onState(s);

  function flush() {
    while (queue.length > 0 && sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(queue.shift()));
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
    sock = new WebSocket(wsUrl());
    sock.onopen = () => {
      initialConnection = false;
      attempts = 0;
      setState("connected");
      flush();
    };
    sock.onmessage = (e) => {
      try {
        handlers.onFrame(JSON.parse(String(e.data)));
      } catch {
        // ignore malformed frames
      }
    };
    sock.onclose = () => {
      sock = null;
      initialConnection = false;
      if (closed) return;
      // Requests queued for this failed connection were marked interrupted by
      // the store. Never replay them silently on a later connection.
      queue.length = 0;
      setState("disconnected");
      scheduleReconnect();
    };
    sock.onerror = () => {
      sock?.close();
    };
  }

  connect();

  return {
    send(frame: ClientFrame) {
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify(frame));
        return true;
      }
      if (initialConnection && sock) {
        queue.push(frame);
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

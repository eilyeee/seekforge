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
  let queuedBytes = 0;

  const wsUrl = () => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const token = handlers.getToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${proto}://${window.location.host}/ws${qs}`;
  };

  const setState = (s: ConnState) => handlers.onState(s);

  function flush() {
    while (queue.length > 0 && sock && sock.readyState === WebSocket.OPEN) {
      const payload = queue.shift() as string;
      queuedBytes -= new TextEncoder().encode(payload).byteLength;
      try {
        sock.send(payload);
      } catch {
        queue.length = 0;
        queuedBytes = 0;
        sock.close();
        return;
      }
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
    let connection: WebSocket;
    try {
      connection = new WebSocket(wsUrl());
    } catch {
      sock = null;
      initialConnection = false;
      setState("disconnected");
      scheduleReconnect();
      return;
    }
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
      queuedBytes = 0;
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
        try {
          sock.send(payload);
          return true;
        } catch {
          sock.close();
          return false;
        }
      }
      if (initialConnection && sock) {
        const bytes = new TextEncoder().encode(payload).byteLength;
        if (queuedBytes + bytes > MAX_WS_PAYLOAD_BYTES) return false;
        queue.push(payload);
        queuedBytes += bytes;
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      queue.length = 0;
      queuedBytes = 0;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sock?.close();
      setState("disconnected");
    },
  };
}

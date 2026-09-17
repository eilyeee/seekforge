/**
 * Client for the workspace terminal socket (/ws/terminal, SERVER-API.md).
 * One socket = one shell; closing it ends the shell server-side. There is no
 * reconnect: a dropped terminal is reported and the user starts a new one.
 */
import { isMock } from "../mock";

export type TerminalFrame =
  | { type: "ready"; shell: string; cwd: string; pty: boolean }
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; code: string; message: string };

export type TerminalConnection = {
  input: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
};

export type TerminalHandlers = {
  onFrame: (frame: TerminalFrame) => void;
  /** The socket is gone (after an exit frame, or unexpectedly). */
  onClose: () => void;
};

export function isTerminalFrame(value: unknown): value is TerminalFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "ready":
      return typeof frame.shell === "string" && typeof frame.cwd === "string";
    case "output":
      return typeof frame.data === "string";
    case "exit":
      return true;
    case "error":
      return typeof frame.message === "string";
    default:
      return false;
  }
}

function mockTerminal(handlers: TerminalHandlers): TerminalConnection {
  let open = true;
  queueMicrotask(() => {
    handlers.onFrame({ type: "ready", shell: "/bin/mock", cwd: "/mock/workspace", pty: false });
    handlers.onFrame({ type: "output", data: "mock terminal — input is echoed\r\n$ " });
  });
  return {
    input: (data) => {
      if (open) handlers.onFrame({ type: "output", data: data.replace(/\r/g, "\r\n$ ") });
    },
    resize: () => {},
    close: () => {
      if (!open) return;
      open = false;
      handlers.onClose();
    },
  };
}

export function openTerminalConnection(url: string, handlers: TerminalHandlers): TerminalConnection {
  if (isMock()) return mockTerminal(handlers);
  const socket = new WebSocket(url);
  const queue: string[] = [];
  let closed = false;
  const send = (payload: string) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    else if (socket.readyState === WebSocket.CONNECTING) queue.push(payload);
  };
  socket.onopen = () => {
    for (const payload of queue.splice(0)) socket.send(payload);
  };
  socket.onmessage = (event) => {
    try {
      const frame: unknown = JSON.parse(String(event.data));
      if (isTerminalFrame(frame)) handlers.onFrame(frame);
    } catch {
      // ignore malformed frames
    }
  };
  socket.onclose = () => {
    if (closed) return;
    closed = true;
    handlers.onClose();
  };
  socket.onerror = () => socket.close();
  return {
    input: (data) => send(JSON.stringify({ type: "input", data })),
    resize: (cols, rows) => send(JSON.stringify({ type: "resize", cols, rows })),
    close: () => {
      if (closed) return;
      closed = true;
      socket.close();
    },
  };
}

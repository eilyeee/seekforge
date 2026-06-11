import { create } from "zustand";
import type { ChatMessage, PermissionRequest } from "@seekforge/shared";
import { setTokenProvider } from "./lib/api";
import {
  appendUser,
  initialChatState,
  reduceEvent,
  type ChatState,
} from "./lib/events";
import { messagesToItems } from "./lib/messages";
import { createWsClient, type ConnState, type ServerFrame, type WsClient } from "./lib/ws";
import { emptyUsage } from "./lib/usage";
import type { SessionMeta } from "./types";

export type View = "chat" | "sessions" | "diff" | "skills" | "memory" | "settings";

export type PendingPermission = { requestId: string; request: PermissionRequest };

function readTokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

type AppStore = {
  view: View;
  token: string;
  conn: ConnState;
  chat: ChatState;
  pendingPermission: PendingPermission | null;
  /** Last protocol-level WS error ({"type":"error"} frame). */
  wsError: string | null;

  setView: (view: View) => void;
  connect: () => void;
  sendTask: (task: string) => void;
  cancel: () => void;
  newSession: () => void;
  respondPermission: (approved: boolean) => void;
  continueSession: (meta: SessionMeta, messages: ChatMessage[]) => void;
};

let ws: WsClient | null = null;

export const useStore = create<AppStore>()((set, get) => {
  const handleFrame = (frame: ServerFrame): void => {
    switch (frame.type) {
      case "event":
        set((s) => ({ chat: reduceEvent(s.chat, frame.event) }));
        break;
      case "permission.request":
        set({ pendingPermission: { requestId: frame.requestId, request: frame.request } });
        break;
      case "error":
        set((s) => ({
          wsError: `${frame.code}: ${frame.message}`,
          // "busy" means our run request was rejected — stop the spinner.
          chat: frame.code === "busy" ? s.chat : { ...s.chat, running: false },
        }));
        break;
      case "idle":
        set((s) => ({ chat: { ...s.chat, running: false }, pendingPermission: null }));
        break;
    }
  };

  const ensureWs = (): WsClient => {
    if (!ws) {
      ws = createWsClient({
        getToken: () => get().token,
        onFrame: handleFrame,
        onState: (conn) => set({ conn }),
      });
    }
    return ws;
  };

  return {
    view: "chat",
    token: readTokenFromLocation(),
    conn: "disconnected",
    chat: initialChatState(),
    pendingPermission: null,
    wsError: null,

    setView: (view) => set({ view }),

    connect: () => {
      ensureWs();
    },

    sendTask: (task) => {
      const { chat } = get();
      if (chat.running || task.trim() === "") return;
      const client = ensureWs();
      set({ chat: { ...appendUser(chat, task), running: true }, wsError: null });
      if (chat.sessionId) {
        client.send({ type: "send", sessionId: chat.sessionId, task });
      } else {
        client.send({ type: "start", task, mode: "edit", approvalMode: "confirm" });
      }
    },

    cancel: () => {
      ws?.send({ type: "cancel" });
    },

    newSession: () => {
      set({ chat: initialChatState(), pendingPermission: null, wsError: null });
    },

    respondPermission: (approved) => {
      const pending = get().pendingPermission;
      if (!pending) return;
      ws?.send({ type: "permission.response", requestId: pending.requestId, approved });
      set({ pendingPermission: null });
    },

    continueSession: (meta, messages) => {
      const items = messagesToItems(messages);
      set({
        view: "chat",
        pendingPermission: null,
        wsError: null,
        chat: {
          items,
          sessionId: meta.id,
          running: false,
          usage: meta.usage ?? emptyUsage(),
          // messagesToItems assigns sequential ids starting at 1.
          nextId: items.length + 1,
        },
      });
    },
  };
});

setTokenProvider(() => useStore.getState().token);

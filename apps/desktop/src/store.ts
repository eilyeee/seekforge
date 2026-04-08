import { create } from "zustand";
import type { ChatMessage } from "@seekforge/shared";
import { setTokenProvider } from "./lib/api";
import { appendUser, initialChatState } from "./lib/events";
import { buildExecutePlanFrame, buildStartFrame, EXECUTE_PLAN_TASK } from "./lib/frames";
import { messagesToItems } from "./lib/messages";
import { notify, requestNotifyPermission } from "./lib/notify";
import {
  activeTab,
  closeTab as closeTabPure,
  initialTabsState,
  openTab as openTabPure,
  routeFrame,
  switchTab,
  titleFromTask,
  updateTab,
  DEFAULT_TAB_TITLE,
  type ChatTab,
  type PendingPermission,
  type StartMode,
  type TabsState,
} from "./lib/tabs";
import { createWsClient, type ServerFrame, type WsClient } from "./lib/ws";
import { emptyUsage } from "./lib/usage";
import type { SessionMeta } from "./types";

export type View = "chat" | "sessions" | "diff" | "skills" | "agents" | "memory" | "evolution" | "settings";

export type { ChatTab, PendingPermission, StartMode };
export { activeTab };

function readTokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

type AppStore = {
  view: View;
  token: string;
  tabs: TabsState;

  setView: (view: View) => void;
  /** Ensures the active tab has a (re)connecting WS client. */
  connect: () => void;
  openTab: () => void;
  /** Closing also closes the tab's socket — a running session is cancelled server-side. */
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setMode: (mode: StartMode) => void;
  setAutoApprove: (on: boolean) => void;
  sendTask: (task: string) => void;
  executePlan: () => void;
  cancel: () => void;
  newSession: () => void;
  respondPermission: (approved: boolean) => void;
  continueSession: (meta: SessionMeta, messages: ChatMessage[]) => void;
};

/**
 * One WS connection per tab (the server allows a single running session per
 * connection). Lives outside the store: sockets are not state.
 */
const wsByTab = new Map<string, WsClient>();

export const useStore = create<AppStore>()((set, get) => {
  const handleFrame = (tabId: string, frame: ServerFrame): void => {
    // Title is read before routing; it does not change mid-run.
    const tab = get().tabs.tabs.find((t) => t.tabId === tabId);
    set((s) => ({ tabs: routeFrame(s.tabs, tabId, frame) }));
    if (!tab) return;
    if (frame.type === "permission.request") notify({ kind: "permission" });
    else if (frame.type === "event" && frame.event.type === "session.completed")
      notify({ kind: "completed", tabTitle: tab.title });
    else if (frame.type === "event" && frame.event.type === "session.failed")
      notify({ kind: "failed", tabTitle: tab.title });
  };

  const ensureWs = (tabId: string): WsClient => {
    let client = wsByTab.get(tabId);
    if (!client) {
      client = createWsClient({
        getToken: () => get().token,
        onFrame: (frame) => handleFrame(tabId, frame),
        onState: (conn) => set((s) => ({ tabs: updateTab(s.tabs, tabId, { conn }) })),
      });
      wsByTab.set(tabId, client);
    }
    return client;
  };

  return {
    view: "chat",
    token: readTokenFromLocation(),
    tabs: initialTabsState(),

    setView: (view) => set({ view }),

    connect: () => {
      ensureWs(get().tabs.activeTabId);
    },

    openTab: () => {
      set((s) => ({ tabs: openTabPure(s.tabs) }));
      ensureWs(get().tabs.activeTabId);
    },

    closeTab: (tabId) => {
      wsByTab.get(tabId)?.close();
      wsByTab.delete(tabId);
      set((s) => ({ tabs: closeTabPure(s.tabs, tabId) }));
    },

    setActiveTab: (tabId) => {
      set((s) => ({ tabs: switchTab(s.tabs, tabId) }));
    },

    setMode: (mode) => set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { mode }) })),

    setAutoApprove: (on) => set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { autoApprove: on }) })),

    sendTask: (task) => {
      const tab = activeTab(get().tabs);
      if (tab.chat.running || task.trim() === "") return;
      const client = ensureWs(tab.tabId);
      requestNotifyPermission();

      const patch: Partial<ChatTab> = {
        chat: { ...appendUser(tab.chat, task), running: true },
        wsError: null,
        planReady: false,
      };
      if (tab.chat.sessionId) {
        client.send({ type: "send", sessionId: tab.chat.sessionId, task });
      } else {
        patch.title = titleFromTask(task);
        patch.planPending = tab.mode === "plan";
        client.send(buildStartFrame(task, tab.mode, tab.autoApprove));
      }
      set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, patch) }));
    },

    executePlan: () => {
      const tab = activeTab(get().tabs);
      if (tab.chat.running || !tab.chat.sessionId || !tab.planReady) return;
      const client = ensureWs(tab.tabId);
      requestNotifyPermission();
      client.send(buildExecutePlanFrame(tab.chat.sessionId));
      set((s) => ({
        tabs: updateTab(s.tabs, tab.tabId, {
          chat: { ...appendUser(tab.chat, EXECUTE_PLAN_TASK), running: true },
          wsError: null,
          planReady: false,
        }),
      }));
    },

    cancel: () => {
      wsByTab.get(get().tabs.activeTabId)?.send({ type: "cancel" });
    },

    newSession: () => {
      set((s) => ({
        tabs: updateTab(s.tabs, s.tabs.activeTabId, {
          title: DEFAULT_TAB_TITLE,
          chat: initialChatState(),
          pendingPermission: null,
          wsError: null,
          planPending: false,
          planReady: false,
        }),
      }));
    },

    respondPermission: (approved) => {
      const tab = activeTab(get().tabs);
      const pending = tab.pendingPermission;
      if (!pending) return;
      wsByTab.get(tab.tabId)?.send({ type: "permission.response", requestId: pending.requestId, approved });
      set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, { pendingPermission: null }) }));
    },

    continueSession: (meta, messages) => {
      const items = messagesToItems(messages);
      set((s) => {
        // "Continue this session" always opens a NEW tab bound to the session.
        let tabs = openTabPure(s.tabs);
        tabs = updateTab(tabs, tabs.activeTabId, {
          title: titleFromTask(meta.task),
          chat: {
            items,
            sessionId: meta.id,
            running: false,
            usage: meta.usage ?? emptyUsage(),
            contextUsage: null,
            // messagesToItems assigns sequential ids starting at 1.
            nextId: items.length + 1,
          },
        });
        return { tabs, view: "chat" as const };
      });
      ensureWs(get().tabs.activeTabId);
    },
  };
});

setTokenProvider(() => useStore.getState().token);

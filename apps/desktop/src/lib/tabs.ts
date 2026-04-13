/**
 * Pure multi-tab chat state reducer. Each tab owns an independent ChatState,
 * WS connection state, pending permission and plan/approval controls. The
 * zustand store delegates here; no DOM, no sockets — unit-tested in
 * tabs.test.ts.
 */
import type { PermissionRequest } from "@seekforge/shared";
import { initialChatState, reduceEvent, type ChatState } from "./events";
import type { ConnState, ServerFrame } from "./ws-types";

/** Mode selector for the NEXT start frame ("plan" = ask mode + plan flag). */
export type StartMode = "edit" | "plan" | "ask";

export type PendingPermission = { requestId: string; request: PermissionRequest };

export type ChatTab = {
  tabId: string;
  /** First words of the first task; placeholder until a task is sent. */
  title: string;
  /**
   * Workspace id this tab is bound to. Set when the tab is opened (from the
   * then-active workspace) and never changes — a tab keeps running its session
   * in its original workspace even after the active workspace switches.
   * Empty = the server's default (first) workspace.
   */
  ws: string;
  chat: ChatState;
  conn: ConnState;
  pendingPermission: PendingPermission | null;
  /** Last protocol-level WS error ({"type":"error"} frame) on this tab. */
  wsError: string | null;
  mode: StartMode;
  /** approvalMode "auto" for the next start when true. */
  autoApprove: boolean;
  /** The current run was started with plan: true. */
  planPending: boolean;
  /** A plan run completed — offer the "Execute plan" button. */
  planReady: boolean;
};

export type TabsState = {
  tabs: ChatTab[];
  activeTabId: string;
  /** Monotonic counter for tab ids (pure — no Math.random). */
  nextTabNum: number;
};

export const DEFAULT_TAB_TITLE = "new tab";

/** Tab title = first words of the task, truncated. */
export function titleFromTask(task: string): string {
  const words = task.trim().split(/\s+/).slice(0, 6).join(" ");
  const max = 28;
  if (words.length <= max) return words || DEFAULT_TAB_TITLE;
  return `${words.slice(0, max - 1)}…`;
}

function makeTab(tabId: string, ws = ""): ChatTab {
  return {
    tabId,
    title: DEFAULT_TAB_TITLE,
    ws,
    chat: initialChatState(),
    conn: "disconnected",
    pendingPermission: null,
    wsError: null,
    mode: "edit",
    autoApprove: false,
    planPending: false,
    planReady: false,
  };
}

export function initialTabsState(ws = ""): TabsState {
  return { tabs: [makeTab("t1", ws)], activeTabId: "t1", nextTabNum: 2 };
}

export function activeTab(state: TabsState): ChatTab {
  return state.tabs.find((t) => t.tabId === state.activeTabId) ?? state.tabs[0]!;
}

/** Appends a fresh tab bound to `ws` (the active workspace) and activates it. */
export function openTab(state: TabsState, ws = ""): TabsState {
  const tabId = `t${state.nextTabNum}`;
  return {
    tabs: [...state.tabs, makeTab(tabId, ws)],
    activeTabId: tabId,
    nextTabNum: state.nextTabNum + 1,
  };
}

/**
 * Removes a tab. Closing the active tab activates its right neighbour
 * (or the new last tab); closing the last remaining tab leaves a fresh one.
 */
export function closeTab(state: TabsState, tabId: string): TabsState {
  const idx = state.tabs.findIndex((t) => t.tabId === tabId);
  if (idx < 0) return state;
  const closedWs = state.tabs[idx]!.ws;
  const tabs = state.tabs.filter((t) => t.tabId !== tabId);
  if (tabs.length === 0) {
    // The replacement tab keeps the closed tab's workspace binding.
    const fresh = makeTab(`t${state.nextTabNum}`, closedWs);
    return { tabs: [fresh], activeTabId: fresh.tabId, nextTabNum: state.nextTabNum + 1 };
  }
  let activeTabId = state.activeTabId;
  if (activeTabId === tabId) {
    activeTabId = tabs[Math.min(idx, tabs.length - 1)]!.tabId;
  }
  return { ...state, tabs, activeTabId };
}

export function switchTab(state: TabsState, tabId: string): TabsState {
  if (!state.tabs.some((t) => t.tabId === tabId)) return state;
  if (state.activeTabId === tabId) return state;
  return { ...state, activeTabId: tabId };
}

export function updateTab(
  state: TabsState,
  tabId: string,
  patch: Partial<ChatTab> | ((tab: ChatTab) => Partial<ChatTab>),
): TabsState {
  const idx = state.tabs.findIndex((t) => t.tabId === tabId);
  if (idx < 0) return state;
  const tab = state.tabs[idx]!;
  const next = [...state.tabs];
  next[idx] = { ...tab, ...(typeof patch === "function" ? patch(tab) : patch) };
  return { ...state, tabs: next };
}

/**
 * Routes a server frame to its tab (frames arrive on per-tab WS connections,
 * so the tabId is known from the connection, not the frame).
 */
export function routeFrame(state: TabsState, tabId: string, frame: ServerFrame): TabsState {
  switch (frame.type) {
    case "event":
      return updateTab(state, tabId, (tab) => {
        const chat = reduceEvent(tab.chat, frame.event);
        if (frame.event.type === "session.completed") {
          // A plan-mode run that completed has produced the plan text.
          return { chat, planReady: tab.planPending || tab.planReady, planPending: false };
        }
        if (frame.event.type === "session.failed") {
          return { chat, planPending: false };
        }
        return { chat };
      });

    case "permission.request":
      return updateTab(state, tabId, {
        pendingPermission: { requestId: frame.requestId, request: frame.request },
      });

    case "error":
      return updateTab(state, tabId, (tab) => ({
        wsError: `${frame.code}: ${frame.message}`,
        // "busy" = a run is already active on this connection; any other
        // protocol error means our run request failed — stop the spinner.
        chat: frame.code === "busy" ? tab.chat : { ...tab.chat, running: false },
      }));

    case "idle":
      return updateTab(state, tabId, (tab) => ({
        chat: { ...tab.chat, running: false },
        pendingPermission: null,
      }));

    default:
      // Unknown frame types from a newer server are ignored.
      return state;
  }
}

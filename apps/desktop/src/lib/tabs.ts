/**
 * Pure multi-tab chat state reducer. Each tab owns an independent ChatState,
 * WS connection state, pending permission and plan/approval controls. The
 * zustand store delegates here; no DOM, no sockets — unit-tested in
 * tabs.test.ts.
 */
import type { PermissionRequest } from "@seekforge/shared";
import { initialChatState, reduceEvent, type ChatState } from "./events";
import { emptyLoopProgress, reduceLoopEvent, type LoopProgress } from "./loop";
import type { ConnState, ServerFrame } from "./ws-types";

/** Mode selector for the NEXT start frame ("plan" = ask mode + plan flag). */
export type StartMode = "edit" | "plan" | "ask";

/** Approval selector for the NEXT start frame (maps to the run's approvalMode). */
export type ApprovalChoice = "confirm" | "acceptEdits" | "auto";

export type PendingPermission = { requestId: string; request: PermissionRequest };

/** ask_user question awaiting an answer (question.request frame). */
export type PendingQuestion = { id: string; question: string; options: string[] };

/** Worktree session binding: the tab's `ws` is the worktree's workspace id. */
export type TabWorktree = {
  /** Worktree id == its workspace id (`wt-<slug>`). */
  id: string;
  /** Branch the session runs on (`seekforge/<slug>`). */
  branch: string;
  /** Workspace id of the base repo (where merge-back lands). */
  base: string;
  /** Uncommitted changes in the worktree (refreshed after runs). */
  dirty: boolean;
};

/** Chip label for a worktree tab: the slug part of `seekforge/<slug>`. */
export function worktreeLabel(wt: TabWorktree): string {
  return wt.branch.replace(/^seekforge\//, "");
}

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
  /**
   * Set when this tab is an isolated worktree session ("New worktree
   * session"). `ws` then equals `worktree.id`, so the chat WS and all
   * scoped REST calls automatically target the worktree checkout.
   */
  worktree?: TabWorktree;
  chat: ChatState;
  conn: ConnState;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  /** Last protocol-level WS error ({"type":"error"} frame) on this tab. */
  wsError: string | null;
  mode: StartMode;
  /** Approval mode for the next start ("confirm" prompts; "auto" never does). */
  approvalMode: ApprovalChoice;
  /** The current run was started with plan: true. */
  planPending: boolean;
  /** A plan run completed — offer the "Execute plan" button. */
  planReady: boolean;
  /** Model override sent with each start/send; empty = server config default. */
  model: string;
  /** Thinking toggle; null = untouched (server config decides, nothing sent). */
  thinking: boolean | null;
  /** Reasoning effort; only sent while thinking is explicitly on. */
  reasoningEffort: "high" | "max";
  /**
   * Loop-mode progress for this tab: the streamed loop.event feed + the final
   * result. Reset when a new loop starts or the session is reset.
   */
  loop: LoopProgress;
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
    pendingQuestion: null,
    wsError: null,
    mode: "edit",
    approvalMode: "confirm",
    planPending: false,
    planReady: false,
    model: "",
    thinking: null,
    reasoningEffort: "high",
    loop: emptyLoopProgress(),
  };
}

export function initialTabsState(ws = ""): TabsState {
  return { tabs: [makeTab("t1", ws)], activeTabId: "t1", nextTabNum: 2 };
}

export function activeTab(state: TabsState): ChatTab {
  return state.tabs.find((t) => t.tabId === state.activeTabId) ?? state.tabs[0]!;
}

/**
 * Appends a fresh tab bound to `ws` (the active workspace) and activates it.
 * `patch` seeds extra fields on the new tab (e.g. a worktree binding).
 */
export function openTab(state: TabsState, ws = "", patch?: Partial<ChatTab>): TabsState {
  const tabId = `t${state.nextTabNum}`;
  return {
    tabs: [...state.tabs, { ...makeTab(tabId, ws), ...patch }],
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
  const closed = state.tabs[idx]!;
  // The replacement tab keeps the closed tab's workspace binding — except for
  // worktree tabs, whose workspace may no longer exist: fall back to the base.
  const closedWs = closed.worktree ? closed.worktree.base : closed.ws;
  const tabs = state.tabs.filter((t) => t.tabId !== tabId);
  if (tabs.length === 0) {
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

    case "question.request":
      return updateTab(state, tabId, {
        pendingQuestion: { id: frame.id, question: frame.question, options: frame.options },
      });

    case "loop.event":
      return updateTab(state, tabId, (tab) => ({
        loop: reduceLoopEvent(tab.loop, frame.event),
      }));

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
        pendingQuestion: null,
      }));

    default:
      // Unknown frame types from a newer server are ignored.
      return state;
  }
}

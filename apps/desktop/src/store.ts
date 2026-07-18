import { create } from "zustand";
import type { AgentEvent, ChatMessage } from "@seekforge/shared";
import { api, ApiError, setTokenProvider, setWorkspaceProvider } from "./lib/api";
import { truncateChatAtItem } from "./lib/backtrack";
import { appendUser, initialChatState } from "./lib/events";
import { buildExecutePlanFrame, buildSendFrame, buildStartFrame, overridesOf, EXECUTE_PLAN_TASK } from "./lib/frames";
import { emptyLoopProgress } from "./lib/loop";
import { messagesToItems } from "./lib/messages";
import { notify, requestNotifyPermission } from "./lib/notify";
import { needsOnboarding } from "./lib/onboarding";
import {
  activeTab,
  closeTab as closeTabPure,
  initialTabsState,
  openTab as openTabPure,
  routeFrame,
  routeConnectionState,
  switchTab,
  titleFromTask,
  updateTab,
  DEFAULT_TAB_TITLE,
  type ApprovalChoice,
  type ChatTab,
  type PendingPermission,
  type PendingQuestion,
  type StartMode,
  type TabsState,
} from "./lib/tabs";
import { createWsClient, type ClientFrame, type ServerFrame, type WsClient } from "./lib/ws";
import { emptyUsage } from "./lib/usage";
import type { RecentWorkspace, SessionMeta, Workspace, WorktreeMergeResult } from "./types";

export type View =
  | "chat"
  | "sessions"
  | "diff"
  | "files"
  | "git"
  | "skills"
  | "agents"
  | "memory"
  | "evolution"
  | "hooks"
  | "security"
  | "settings"
  | "diagnostics";

export type { ApprovalChoice, ChatTab, PendingPermission, PendingQuestion, StartMode };
export { activeTab };

function readTokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

/**
 * Persisted active-workspace *path*, so reopening the app restores your project.
 * The path is the durable identity: the server re-derives the same workspace id
 * from a path, and recents are keyed by path, so on relaunch we can re-host the
 * last project even though the fresh server only hosts its launch cwd.
 */
const ACTIVE_WS_PATH_KEY = "seekforge.activeWorkspacePath";
function readStoredActivePath(): string {
  try {
    return typeof window === "undefined" ? "" : (window.localStorage.getItem(ACTIVE_WS_PATH_KEY) ?? "");
  } catch {
    return "";
  }
}
function storeActivePath(path: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(ACTIVE_WS_PATH_KEY, path);
  } catch {
    /* private-mode / quota — non-fatal */
  }
}

type AppStore = {
  view: View;
  token: string;
  tabs: TabsState;
  /** Hosted workspaces (GET /api/workspaces); empty until loaded. */
  workspaces: Workspace[];
  /** Recently-opened workspace paths not currently hosted (for the open menu). */
  recents: RecentWorkspace[];
  /**
   * Active workspace id — the one new tabs bind to and workspace-scoped views
   * read from. Empty = the server's default (first) workspace.
   */
  activeWorkspaceId: string;

  /** Loads the workspace list at boot and selects the first one. */
  loadWorkspaces: () => void;
  /** Switches the active workspace (new tabs + views follow it). */
  setActiveWorkspace: (id: string) => void;
  /**
   * Opens a folder as a workspace (POST /api/workspaces), then switches to it.
   * Rejects (ApiError) when the path isn't a directory.
   */
  openWorkspace: (path: string) => Promise<void>;
  /** Stops hosting a workspace; falls back to the default if it was active. */
  removeWorkspace: (id: string) => Promise<void>;
  /** Forgets a recent path (does not affect hosting). */
  forgetRecent: (path: string) => Promise<void>;

  /**
   * First-run onboarding gate. "unknown" until config is fetched; "needed"
   * when no API key is configured; "done" once a key is saved or the user
   * skipped (drops into the app read-only). The app entry renders Onboarding
   * while this is "needed".
   */
  onboarding: "unknown" | "needed" | "done";
  /** Fetches /api/config and sets `onboarding` (needed when no key). */
  checkOnboarding: () => void;
  /** Marks onboarding complete (after a successful key save or a skip). */
  finishOnboarding: () => void;

  /**
   * Set when a boot loader (`loadWorkspaces`/`checkOnboarding`) fails to reach
   * the REST server. Drives the global "server unreachable" banner; null while
   * healthy. `retryBoot()` clears it and re-runs both loaders.
   */
  bootError: string | null;
  /** Re-runs the boot loaders (workspaces + onboarding) after a failure. */
  retryBoot: () => void;

  /** Whether the todos drawer is open (global, not per-tab). */
  todosOpen: boolean;
  toggleTodos: () => void;

  /** Whether the ⌘K command palette overlay is open. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** "Go to file" finder (⌘/Ctrl+P); openable from any view. */
  filesFinderOpen: boolean;
  setFilesFinderOpen: (open: boolean) => void;
  openFilesFinder: () => void;
  /**
   * A pending "open this file (optionally at a line/match)" request, consumed by
   * the Files view. `nonce` makes repeat opens of the same target re-fire.
   */
  filesTarget: { path: string; line?: number; col?: number; len?: number; nonce: number } | null;
  openFileAt: (path: string, loc?: { line?: number; col?: number; len?: number }) => void;
  clearFilesTarget: () => void;

  setView: (view: View) => void;
  /**
   * Cross-view composer seed: another view (e.g. "Ask this subagent") stashes a
   * draft here and switches to chat; ChatView applies it to the active tab once.
   */
  chatDraft: string | null;
  composeInChat: (text: string) => void;
  clearChatDraft: () => void;
  /** Ensures the active tab has a (re)connecting WS client. */
  connect: () => void;
  openTab: () => void;
  /**
   * "New worktree session": creates an isolated git worktree in the active
   * workspace and opens a tab bound to its workspace (`wt-<slug>`). Rejects
   * (ApiError) e.g. when the workspace is not a git repo.
   */
  openWorktreeTab: () => Promise<void>;
  /**
   * "Merge back": merges the tab's worktree branch into its base workspace
   * (the server auto-commits dirty work first). Resolves with the server's
   * verdict; on {conflict} everything is left intact (merge aborted).
   */
  mergeWorktree: (tabId: string) => Promise<WorktreeMergeResult>;
  /** "Discard"/post-merge cleanup: deletes the worktree+branch, closes the tab. */
  discardWorktree: (tabId: string) => Promise<void>;
  /** Refreshes the dirty flag of all worktree tabs (after runs finish). */
  refreshWorktrees: () => void;
  /** Closing also closes the tab's socket — a running session is cancelled server-side. */
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setMode: (mode: StartMode) => void;
  setApprovalMode: (approvalMode: ApprovalChoice) => void;
  /** Chat-header run controls (per tab, sent with each start/send). */
  setModel: (model: string) => void;
  setThinking: (on: boolean) => void;
  setReasoningEffort: (effort: "high" | "max") => void;
  setOutputStyle: (style: string) => void;
  setSandbox: (sandbox: ChatTab["sandbox"]) => void;
  /**
   * Drops the given user item and everything after it from the active tab's
   * transcript (after a successful POST backtrack on the server).
   */
  truncateAtItem: (tabId: string, sessionId: string, itemId: number) => void;
  /** Sends a chat task; returns false when the socket rejected it (offline). */
  sendTask: (task: string) => boolean;
  /**
   * Starts loop mode on the active tab: sends a `loop` frame on the tab's WS,
   * marks the tab running, and resets the tab's loop progress. The server runs
   * the task→verify→fix cycle autonomously and streams `loop.event` frames.
   */
  startLoop: (opts: {
    task: string;
    verifyCommand: string;
    maxIterations?: number;
    budget?: number;
    requirementMode?: "quick" | "analyze" | "confirm";
  }) => void;
  /** Resumes the persisted loop represented by the active tab's completed result. */
  resumeLoop: (opts: {
    loopId: string;
    addedIterations?: number;
    addedBudget?: number;
    approveRequirements?: boolean;
  }) => void;
  executePlan: () => void;
  cancel: () => void;
  /** Queue guidance for one running subagent at its next model-turn boundary. */
  steerSubagent: (dispatchId: string, message: string) => void;
  /** Stop one running subagent without cancelling its parent task. */
  cancelSubagent: (dispatchId: string) => void;
  newSession: () => void;
  respondPermission: (approved: boolean, remember?: "session", selectedHunks?: number[]) => void;
  /** Answers the pending ask_user question on the active tab. */
  respondQuestion: (answer: string) => void;
  continueSession: (meta: SessionMeta, messages: ChatMessage[], workspaceId: string, events?: AgentEvent[]) => void;
};

/**
 * One WS connection per tab (the server allows a single running session per
 * connection). Lives outside the store: sockets are not state.
 */
const wsByTab = new Map<string, WsClient>();

/**
 * Surfaced on a tab's `wsError` when a frame could not be sent because the
 * socket is not OPEN (disconnected / reconnecting). Same raw `code: message`
 * shape as protocol errors so the existing wsError banner renders it. The
 * action is NOT queued — the user must retry once reconnected.
 */
const SEND_DISCONNECTED_ERROR = "disconnected: not sent — reconnect to continue";

/**
 * Tells "the server is down" apart from "this is an old server missing the
 * endpoint". A 404 (and other 4xx) means the endpoint isn't there — that's the
 * expected back-compat case the boot loaders tolerate silently. Anything else
 * (a thrown TypeError from `fetch` when the connection fails, or a 5xx) means
 * the REST server is unreachable and the user should see a recoverable banner.
 */
function isUnreachable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status >= 500;
  return true;
}

function bindBlankInitialTab(tabs: TabsState, workspaceId: string): TabsState {
  const first = tabs.tabs[0];
  if (
    !first ||
    first.worktree ||
    first.chat.sessionId !== null ||
    first.chat.running ||
    first.chat.items.length > 0 ||
    first.title !== DEFAULT_TAB_TITLE
  ) {
    return tabs;
  }
  return updateTab(tabs, first.tabId, { ws: workspaceId });
}

export const useStore = create<AppStore>()((set, get) => {
  let openWorkspaceGeneration = 0;

  const handleFrame = (tabId: string, frame: ServerFrame): void => {
    // Title is read before routing; it does not change mid-run.
    const tab = get().tabs.tabs.find((t) => t.tabId === tabId);
    set((s) => ({ tabs: routeFrame(s.tabs, tabId, frame) }));
    if (!tab) return;
    if (frame.type === "permission.request") notify({ kind: "permission", tool: frame.request.toolName });
    else if (frame.type === "question.request") notify({ kind: "question" });
    else if (frame.type === "event" && frame.event.type === "session.completed")
      notify({ kind: "completed", tabTitle: tab.title });
    else if (frame.type === "event" && frame.event.type === "session.failed")
      notify({ kind: "failed", tabTitle: tab.title });
    // A finished run may have left uncommitted work — refresh the dirty dot.
    if (frame.type === "idle" && tab.worktree) get().refreshWorktrees();
  };

  const ensureWs = (tabId: string): WsClient => {
    let client = wsByTab.get(tabId);
    if (!client) {
      client = createWsClient({
        getToken: () => get().token,
        onFrame: (frame) => handleFrame(tabId, frame),
        onState: (conn) => {
          set((s) => ({ tabs: routeConnectionState(s.tabs, tabId, conn) }));
          if (conn === "connected") {
            const tab = get().tabs.tabs.find((candidate) => candidate.tabId === tabId);
            if (tab?.activeRunId) {
              client?.send({
                type: "subscribe",
                runId: tab.activeRunId,
                afterSeq: tab.runSeq,
                ...(tab.ws ? { ws: tab.ws } : {}),
              });
            }
          }
        },
      });
      wsByTab.set(tabId, client);
    }
    return client;
  };

  return {
    view: "chat",
    token: readTokenFromLocation(),
    tabs: initialTabsState(),
    workspaces: [],
    recents: [],
    activeWorkspaceId: "",

    loadWorkspaces: () => {
      api
        .workspaces()
        .then(({ workspaces, recents }) => {
          const storedPath = readStoredActivePath();
          const restored = storedPath ? workspaces.find((w) => w.path === storedPath) : undefined;
          // Whether the user already picked a workspace this session (a reload
          // after the initial boot): if so, don't override it with auto-reopen.
          const hadPick = !!get().activeWorkspaceId;
          set((s) => {
            // Restore the last-used workspace if it is still hosted; otherwise
            // adopt the first one. An explicit in-session pick always wins.
            const next = s.activeWorkspaceId || restored?.id || (workspaces[0]?.id ?? "");
            return {
              workspaces,
              recents,
              activeWorkspaceId: next,
              tabs: !next || workspaces.length === 0 ? s.tabs : bindBlankInitialTab(s.tabs, next),
            };
          });
          // Auto-reopen the last project on a fresh relaunch: the server only
          // hosts its launch cwd, but if the remembered project is a known
          // recent we re-host + switch to it (the Codex "reopen last" flow).
          if (!hadPick && !restored && storedPath && recents.some((r) => r.path === storedPath)) {
            void get()
              .openWorkspace(storedPath)
              .catch(() => {
                /* the folder may have moved/been deleted — stay on the default */
              });
          }
        })
        .catch((e: unknown) => {
          // Single-workspace / old server without /api/workspaces: stay on the
          // default workspace (empty id -> server's first). A real connection
          // failure (server down) instead surfaces the global recovery banner.
          if (isUnreachable(e)) set({ bootError: String(e instanceof Error ? e.message : e) });
        });
    },

    setActiveWorkspace: (id) => {
      openWorkspaceGeneration += 1;
      const ws = get().workspaces.find((w) => w.id === id);
      if (ws) storeActivePath(ws.path);
      set({ activeWorkspaceId: id });
    },

    openWorkspace: async (path) => {
      const generation = ++openWorkspaceGeneration;
      const { workspace, workspaces, recents } = await api.openWorkspace(path);
      if (generation !== openWorkspaceGeneration) return;
      storeActivePath(workspace.path);
      set((s) => ({
        workspaces,
        recents,
        activeWorkspaceId: workspace.id,
        tabs: bindBlankInitialTab(s.tabs, workspace.id),
      }));
    },

    removeWorkspace: async (id) => {
      const { workspaces, recents } = await api.unhostWorkspace(id);
      // Close any tabs bound to the now-unhosted workspace — their sockets and
      // REST calls would otherwise target a workspace id the server no longer
      // knows (404s). The folder itself is untouched; reopening restores it.
      for (const tabId of get()
        .tabs.tabs.filter((t) => t.ws === id)
        .map((t) => t.tabId)) {
        get().closeTab(tabId);
      }
      set((s) => {
        const stillActive = workspaces.some((w) => w.id === s.activeWorkspaceId);
        const fallback = workspaces[0];
        const nextActive = stillActive ? s.activeWorkspaceId : (fallback?.id ?? "");
        if (!stillActive && fallback) storeActivePath(fallback.path);
        return { workspaces, recents, activeWorkspaceId: nextActive };
      });
    },

    forgetRecent: async (path) => {
      const { workspaces, recents } = await api.forgetRecent(path);
      set({ workspaces, recents });
    },

    onboarding: "unknown",
    checkOnboarding: () => {
      api
        .config()
        .then((config) => set({ onboarding: needsOnboarding(config) ? "needed" : "done" }))
        .catch((e: unknown) => {
          // Can't reach config (offline/old server) — don't block the app. A
          // real connection failure (server down) surfaces the recovery banner
          // so the user knows actions will fail and can retry.
          set({ onboarding: "done" });
          if (isUnreachable(e)) set({ bootError: String(e instanceof Error ? e.message : e) });
        });
    },
    finishOnboarding: () => set({ onboarding: "done" }),

    bootError: null,
    retryBoot: () => {
      set({ bootError: null });
      get().loadWorkspaces();
      get().checkOnboarding();
    },

    setView: (view) => set({ view }),

    chatDraft: null,
    composeInChat: (text) => set({ chatDraft: text, view: "chat" }),
    clearChatDraft: () => set({ chatDraft: null }),

    connect: () => {
      ensureWs(get().tabs.activeTabId);
    },

    openTab: () => {
      set((s) => ({ tabs: openTabPure(s.tabs, s.activeWorkspaceId) }));
      ensureWs(get().tabs.activeTabId);
    },

    openWorktreeTab: async () => {
      const base = get().activeWorkspaceId;
      const created = await api.worktreeCreate(base);
      set((s) => ({
        tabs: openTabPure(s.tabs, created.id, {
          // ws = the worktree's workspace id -> the chat WS and scoped REST
          // calls target the isolated checkout via the existing ?ws= path.
          worktree: { id: created.id, branch: created.branch, base, dirty: false },
        }),
      }));
      ensureWs(get().tabs.activeTabId);
    },

    mergeWorktree: async (tabId) => {
      const tab = get().tabs.tabs.find((t) => t.tabId === tabId);
      if (!tab?.worktree) throw new Error("tab has no worktree");
      const result = await api.worktreeMerge(tab.worktree.id);
      get().refreshWorktrees();
      return result;
    },

    discardWorktree: async (tabId) => {
      const tab = get().tabs.tabs.find((t) => t.tabId === tabId);
      if (!tab?.worktree) throw new Error("tab has no worktree");
      await api.worktreeDelete(tab.worktree.id);
      get().closeTab(tabId);
    },

    refreshWorktrees: () => {
      const worktreeTabs = get().tabs.tabs.filter((t) => t.worktree);
      for (const base of new Set(worktreeTabs.map((t) => t.worktree!.base))) {
        api
          .worktrees(base)
          .then((list) => {
            set((s) => {
              let tabs = s.tabs;
              for (const t of s.tabs.tabs) {
                const status = t.worktree && list.find((w) => w.id === t.worktree!.id);
                if (status && status.dirty !== t.worktree!.dirty) {
                  tabs = updateTab(tabs, t.tabId, { worktree: { ...t.worktree!, dirty: status.dirty } });
                }
              }
              return { tabs };
            });
          })
          .catch(() => {
            // Status refresh is best-effort (old server, deleted worktree, ...).
          });
      }
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

    setApprovalMode: (approvalMode) => set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { approvalMode }) })),

    setModel: (model) => set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { model }) })),

    setThinking: (on) => set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { thinking: on }) })),

    setReasoningEffort: (effort) =>
      set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { reasoningEffort: effort }) })),

    setOutputStyle: (outputStyle) => set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { outputStyle }) })),

    setSandbox: (sandbox) => set((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { sandbox }) })),

    todosOpen: false,
    toggleTodos: () => set((s) => ({ todosOpen: !s.todosOpen })),

    paletteOpen: false,
    setPaletteOpen: (open) => set({ paletteOpen: open }),

    filesFinderOpen: false,
    setFilesFinderOpen: (open) => set({ filesFinderOpen: open }),
    openFilesFinder: () => set({ view: "files", filesFinderOpen: true }),

    filesTarget: null,
    openFileAt: (path, loc) => set({ view: "files", filesTarget: { path, ...(loc ?? {}), nonce: Date.now() } }),
    clearFilesTarget: () => set({ filesTarget: null }),

    truncateAtItem: (tabId, sessionId, itemId) =>
      set((s) => ({
        tabs: updateTab(s.tabs, tabId, (tab) =>
          tab.chat.sessionId !== sessionId
            ? tab
            : {
                chat: truncateChatAtItem(tab.chat, itemId),
                planPending: false,
                planReady: false,
                wsError: null,
              },
        ),
      })),

    sendTask: (task) => {
      const tab = activeTab(get().tabs);
      if (tab.chat.running || task.trim() === "") return false;
      const client = ensureWs(tab.tabId);
      requestNotifyPermission();

      const overrides = overridesOf(tab);
      const patch: Partial<ChatTab> = {
        chat: { ...appendUser(tab.chat, task), running: true },
        wsError: null,
        planReady: false,
      };
      const accepted = tab.chat.sessionId
        ? client.send(buildSendFrame(tab.chat.sessionId, task, tab.approvalMode, tab.mode, tab.ws, overrides))
        : client.send(buildStartFrame(task, tab.mode, tab.approvalMode, tab.ws, overrides));
      if (!accepted) {
        // Socket is not OPEN: the task never left the client. Don't append a
        // user bubble or mark running — surface the failure so the caller keeps
        // the draft instead of silently dropping it.
        set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, { wsError: SEND_DISCONNECTED_ERROR }) }));
        return false;
      }
      if (!tab.chat.sessionId) {
        patch.title = titleFromTask(task);
        patch.planPending = tab.mode === "plan";
      }
      set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, patch) }));
      return true;
    },

    startLoop: ({ task, verifyCommand, maxIterations, budget, requirementMode }) => {
      const tab = activeTab(get().tabs);
      if (tab.chat.running || task.trim() === "" || verifyCommand.trim() === "") return;
      const client = ensureWs(tab.tabId);
      requestNotifyPermission();
      const accepted = client.send({
        type: "loop",
        task,
        verifyCommand,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(requirementMode !== undefined ? { requirementMode } : {}),
        ...(tab.ws ? { ws: tab.ws } : {}),
        // Per-loop model/thinking overrides from the run-toolbar, same as a run.
        ...overridesOf(tab),
      });
      if (!accepted) return;
      set((s) => ({
        tabs: updateTab(s.tabs, tab.tabId, {
          // Mark running so every Run control (chat + loop) is disabled, and
          // clear any prior loop feed so the panel starts fresh.
          chat: { ...tab.chat, running: true },
          loop: emptyLoopProgress(),
          loopRunning: true,
          loopResetPending: false,
          wsError: null,
        }),
      }));
    },

    resumeLoop: ({ loopId, addedIterations, addedBudget, approveRequirements }) => {
      const tab = activeTab(get().tabs);
      if (tab.chat.running || loopId.trim() === "") return;
      const client = ensureWs(tab.tabId);
      requestNotifyPermission();
      const frame: ClientFrame = {
        type: "loop.resume",
        loopId,
        ...(addedIterations !== undefined ? { addedIterations } : {}),
        ...(addedBudget !== undefined ? { addedBudget } : {}),
        ...(approveRequirements !== undefined ? { approveRequirements } : {}),
        ...(tab.ws ? { ws: tab.ws } : {}),
        ...overridesOf(tab),
      };
      if (!client.send(frame)) return;
      set((s) => ({
        tabs: updateTab(s.tabs, tab.tabId, {
          chat: { ...tab.chat, running: true },
          loopRunning: true,
          loopResetPending: true,
          wsError: null,
        }),
      }));
    },

    executePlan: () => {
      const tab = activeTab(get().tabs);
      if (tab.chat.running || !tab.chat.sessionId || !tab.planReady) return;
      const client = ensureWs(tab.tabId);
      requestNotifyPermission();
      if (!client.send(buildExecutePlanFrame(tab.chat.sessionId, tab.ws, overridesOf(tab)))) return;
      set((s) => ({
        tabs: updateTab(s.tabs, tab.tabId, {
          chat: { ...appendUser(tab.chat, EXECUTE_PLAN_TASK), running: true },
          wsError: null,
          planReady: false,
        }),
      }));
    },

    cancel: () => {
      const tabId = get().tabs.activeTabId;
      // A dropped cancel is dangerous: the UI looks cancelled but the run keeps
      // going server-side. Surface the failure so the user knows to retry.
      if (wsByTab.get(tabId)?.send({ type: "cancel" }) !== true) {
        set((s) => ({ tabs: updateTab(s.tabs, tabId, { wsError: SEND_DISCONNECTED_ERROR }) }));
      }
    },

    steerSubagent: (dispatchId, message) => {
      const trimmed = message.trim();
      if (!trimmed || trimmed.length > 4000) return;
      const tabId = get().tabs.activeTabId;
      if (wsByTab.get(tabId)?.send({ type: "subagent.steer", dispatchId, message: trimmed }) !== true) {
        set((s) => ({ tabs: updateTab(s.tabs, tabId, { wsError: SEND_DISCONNECTED_ERROR }) }));
      }
    },

    cancelSubagent: (dispatchId) => {
      const tabId = get().tabs.activeTabId;
      if (wsByTab.get(tabId)?.send({ type: "subagent.cancel", dispatchId }) !== true) {
        set((s) => ({ tabs: updateTab(s.tabs, tabId, { wsError: SEND_DISCONNECTED_ERROR }) }));
      }
    },

    newSession: () => {
      if (activeTab(get().tabs).chat.running) return;
      set((s) => ({
        tabs: updateTab(s.tabs, s.tabs.activeTabId, {
          title: DEFAULT_TAB_TITLE,
          chat: initialChatState(),
          pendingPermission: null,
          pendingQuestion: null,
          wsError: null,
          planPending: false,
          planReady: false,
          loop: emptyLoopProgress(),
          loopRunning: false,
          loopResetPending: false,
          activeRunId: null,
          runSeq: 0,
        }),
      }));
    },

    respondPermission: (approved, remember, selectedHunks) => {
      const tab = activeTab(get().tabs);
      const pending = tab.pendingPermission;
      if (!pending) return;
      const sent = wsByTab.get(tab.tabId)?.send({
        type: "permission.response",
        requestId: pending.requestId,
        approved,
        // "session" grows the run's session allowlist (core ConfirmResult).
        ...(remember ? { remember } : {}),
        // Per-hunk selection for multi-hunk apply_patch calls.
        ...(selectedHunks ? { selectedHunks } : {}),
      });
      if (sent !== true) {
        // The server is still awaiting this response — keep the modal up (don't
        // clear pending) and surface the failure so the user can retry.
        set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, { wsError: SEND_DISCONNECTED_ERROR }) }));
        return;
      }
      set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, { pendingPermission: null }) }));
    },

    respondQuestion: (answer) => {
      const tab = activeTab(get().tabs);
      const pending = tab.pendingQuestion;
      if (!pending) return;
      const sent = wsByTab.get(tab.tabId)?.send({ type: "question.answer", id: pending.id, answer });
      if (sent !== true) {
        // Keep the question modal up — the server never received the answer.
        set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, { wsError: SEND_DISCONNECTED_ERROR }) }));
        return;
      }
      set((s) => ({ tabs: updateTab(s.tabs, tab.tabId, { pendingQuestion: null }) }));
    },

    continueSession: (meta, messages, workspaceId, events = []) => {
      const items = messagesToItems(messages, events);
      set((s) => {
        // "Continue this session" always opens a NEW tab bound to the session,
        // in the workspace where the request originated.
        let tabs = openTabPure(s.tabs, workspaceId);
        tabs = updateTab(tabs, tabs.activeTabId, {
          title: titleFromTask(meta.task),
          chat: {
            items,
            sessionId: meta.id,
            running: false,
            usage: meta.usage ?? emptyUsage(),
            contextUsage: null,
            retry: null,
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
setWorkspaceProvider(() => useStore.getState().activeWorkspaceId);

// Load the hosted workspaces once at boot (no-op on old single-workspace
// servers without /api/workspaces — the default workspace stays selected).
useStore.getState().loadWorkspaces();

// Decide whether to show first-run onboarding (no API key configured).
useStore.getState().checkOnboarding();

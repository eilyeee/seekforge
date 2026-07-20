import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, WsClient, WsClientHandlers } from "./lib/ws-types";
import { MAX_WS_PAYLOAD_BYTES } from "@seekforge/shared/protocol-limits";

// Capture every frame the store sends, and let tests drive the onFrame handler.
const sent: ClientFrame[] = [];
let lastHandlers: (WsClientHandlers & { getToken: () => string }) | undefined;
let acceptSend = true;
const openWorkspaceMock = vi.hoisted(() => vi.fn());

vi.mock("./lib/ws", () => ({
  encodeClientFrame: (frame: ClientFrame): string | null => {
    const payload = JSON.stringify(frame);
    return new TextEncoder().encode(payload).byteLength <= MAX_WS_PAYLOAD_BYTES ? payload : null;
  },
  createWsClient: (handlers: WsClientHandlers & { getToken: () => string }): WsClient => {
    lastHandlers = handlers;
    return {
      send: (frame: ClientFrame) => {
        if (!acceptSend) return false;
        sent.push(frame);
        return true;
      },
      close: () => {},
    };
  },
}));

// The store calls api.workspaces()/config() at module load; stub them to no-ops
// (the promises resolve to empty so onboarding/workspace boot is inert).
class MockApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
vi.mock("./lib/api", () => ({
  api: {
    workspaces: () => Promise.resolve({ workspaces: [], recents: [] }),
    config: () => Promise.resolve({}),
    openWorkspace: openWorkspaceMock,
  },
  ApiError: MockApiError,
  setTokenProvider: () => {},
  setWorkspaceProvider: () => {},
}));

const { useStore } = await import("./store");
const { activeTab, initialTabsState, updateTab } = await import("./lib/tabs");

function resetStore(): void {
  sent.length = 0;
  acceptSend = true;
  openWorkspaceMock.mockReset();
  // Fresh single-tab state for each test.
  useStore.setState((s) => ({
    tabs: {
      ...s.tabs,
      tabs: s.tabs.tabs.map((t, i) =>
        i === 0
          ? {
              ...t,
              approvalMode: "confirm" as const,
              mode: "edit" as const,
              chat: { ...t.chat, sessionId: null, running: false },
              pendingPermission: null,
              pendingQuestion: null,
              loopRunning: false,
              loopResetPending: false,
            }
          : t,
      ),
    },
  }));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("store: workspace selection", () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ tabs: initialTabsState("workspace-a"), activeWorkspaceId: "workspace-a" });
  });

  it("does not rebind the first tab after it owns a session", async () => {
    useStore.setState((s) => ({
      tabs: updateTab(s.tabs, "t1", (tab) => ({
        title: "existing session",
        chat: { ...tab.chat, sessionId: "session-a" },
      })),
    }));
    openWorkspaceMock.mockResolvedValue({
      workspace: { id: "workspace-b", name: "B", path: "/b" },
      workspaces: [
        { id: "workspace-a", name: "A", path: "/a" },
        { id: "workspace-b", name: "B", path: "/b" },
      ],
      recents: [],
    });

    await useStore.getState().openWorkspace("/b");

    expect(useStore.getState().activeWorkspaceId).toBe("workspace-b");
    expect(useStore.getState().tabs.tabs[0]!.ws).toBe("workspace-a");
    expect(useStore.getState().tabs.tabs[0]!.chat.sessionId).toBe("session-a");
  });

  it("lets the last concurrent openWorkspace request win", async () => {
    const first = deferred<{
      workspace: { id: string; name: string; path: string };
      workspaces: { id: string; name: string; path: string }[];
      recents: [];
    }>();
    const second = deferred<{
      workspace: { id: string; name: string; path: string };
      workspaces: { id: string; name: string; path: string }[];
      recents: [];
    }>();
    openWorkspaceMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstOpen = useStore.getState().openWorkspace("/first");
    const secondOpen = useStore.getState().openWorkspace("/second");
    second.resolve({
      workspace: { id: "workspace-second", name: "Second", path: "/second" },
      workspaces: [{ id: "workspace-second", name: "Second", path: "/second" }],
      recents: [],
    });
    await secondOpen;
    first.resolve({
      workspace: { id: "workspace-first", name: "First", path: "/first" },
      workspaces: [{ id: "workspace-first", name: "First", path: "/first" }],
      recents: [],
    });
    await firstOpen;

    expect(useStore.getState().activeWorkspaceId).toBe("workspace-second");
    expect(useStore.getState().workspaces.map((workspace) => workspace.id)).toEqual(["workspace-second"]);
    expect(useStore.getState().tabs.tabs[0]!.ws).toBe("workspace-second");
  });
});

describe("store: rejected sends", () => {
  beforeEach(resetStore);

  it("does not mark a rejected task as running", () => {
    useStore.getState().connect();
    acceptSend = false;
    useStore.getState().sendTask("offline task");

    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(false);
    expect(tab.chat.items).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("sendTask reports failure (false) and surfaces a wsError when offline", () => {
    useStore.getState().connect();
    acceptSend = false;
    const ok = useStore.getState().sendTask("offline task");
    expect(ok).toBe(false);
    expect(activeTab(useStore.getState().tabs).wsError).toBeTruthy();
  });

  it("sendTask reports success (true) on an accepted send", () => {
    useStore.getState().connect();
    const ok = useStore.getState().sendTask("do the thing");
    expect(ok).toBe(true);
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(true);
    expect(tab.wsError).toBeNull();
  });

  it("rejects an oversized task without appending or clearing client state", () => {
    useStore.getState().connect();
    const beforeItems = activeTab(useStore.getState().tabs).chat.items;
    const ok = useStore.getState().sendTask("x".repeat(MAX_WS_PAYLOAD_BYTES));
    expect(ok).toBe(false);
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(false);
    expect(tab.chat.items).toEqual(beforeItems);
    expect(tab.wsError).toMatch(/too_large/);
    expect(sent).toEqual([]);
  });

  it("cancel surfaces a wsError when the socket rejects it (run keeps going server-side)", () => {
    useStore.getState().connect();
    acceptSend = false;
    useStore.getState().cancel();
    expect(activeTab(useStore.getState().tabs).wsError).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("steer/cancelSubagent surface a wsError when the socket rejects them", () => {
    useStore.getState().connect();
    acceptSend = false;
    useStore.getState().steerSubagent("ag-1", "look here");
    expect(activeTab(useStore.getState().tabs).wsError).toBeTruthy();
    // Reset the banner, then verify cancelSubagent surfaces its own failure.
    useStore.setState((s) => ({ tabs: updateTab(s.tabs, s.tabs.activeTabId, { wsError: null }) }));
    useStore.getState().cancelSubagent("ag-1");
    expect(activeTab(useStore.getState().tabs).wsError).toBeTruthy();
    expect(sent).toEqual([]);
  });
});

describe("store: control responses keep pending when the socket rejects them", () => {
  beforeEach(() => {
    resetStore();
    // Inject both a pending permission and a pending question on the active tab.
    useStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        tabs: s.tabs.tabs.map((t, i) =>
          i === 0
            ? {
                ...t,
                pendingPermission: {
                  requestId: "p1",
                  request: { toolName: "run_command", permission: "execute", description: "Run", command: "ls" },
                },
                pendingQuestion: { id: "q1", question: "Pick", options: ["a", "b"] },
              }
            : t,
        ),
      },
    }));
    useStore.getState().connect();
  });

  it("respondPermission keeps the modal up and surfaces a wsError when the send fails", () => {
    acceptSend = false;
    useStore.getState().respondPermission(true);
    const tab = activeTab(useStore.getState().tabs);
    // Pending is preserved: the server is still awaiting a response.
    expect(tab.pendingPermission).not.toBeNull();
    expect(tab.wsError).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("respondPermission clears pending on an accepted send", () => {
    useStore.getState().respondPermission(true);
    expect(activeTab(useStore.getState().tabs).pendingPermission).toBeNull();
  });

  it("respondQuestion keeps the modal up and surfaces a wsError when the send fails", () => {
    acceptSend = false;
    useStore.getState().respondQuestion("a");
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.pendingQuestion).not.toBeNull();
    expect(tab.wsError).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("respondQuestion clears pending on an accepted send", () => {
    useStore.getState().respondQuestion("a");
    expect(activeTab(useStore.getState().tabs).pendingQuestion).toBeNull();
  });
});

describe("store: session reset lifecycle", () => {
  beforeEach(resetStore);

  it("does not reset a session while its run is active", () => {
    useStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        tabs: s.tabs.tabs.map((tab) => ({
          ...tab,
          title: "active task",
          chat: { ...tab.chat, running: true, sessionId: "session-a" },
        })),
      },
    }));
    useStore.getState().newSession();
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.title).toBe("active task");
    expect(tab.chat.running).toBe(true);
    expect(tab.chat.sessionId).toBe("session-a");
  });
});

describe("store: approval mode selector → start frame", () => {
  beforeEach(resetStore);

  it("threads the chosen approvalMode into the start frame", () => {
    useStore.getState().setApprovalMode("acceptEdits");
    expect(activeTab(useStore.getState().tabs).approvalMode).toBe("acceptEdits");

    useStore.getState().sendTask("do the thing");
    const start = sent.find((f) => f.type === "start");
    expect(start).toMatchObject({ type: "start", approvalMode: "acceptEdits" });
  });

  it("defaults to confirm and can switch to auto", () => {
    useStore.getState().sendTask("first");
    expect(sent.find((f) => f.type === "start")).toMatchObject({ approvalMode: "confirm" });

    resetStore();
    useStore.getState().setApprovalMode("auto");
    useStore.getState().sendTask("second");
    expect(sent.find((f) => f.type === "start")).toMatchObject({ approvalMode: "auto" });
  });
});

describe("store: subagent controls", () => {
  beforeEach(() => {
    resetStore();
    useStore.getState().connect();
  });

  it("sends trimmed steering and targeted cancellation frames", () => {
    useStore.getState().steerSubagent("ag-7", "  inspect the parser boundary  ");
    useStore.getState().cancelSubagent("ag-7");
    expect(sent).toContainEqual({
      type: "subagent.steer",
      dispatchId: "ag-7",
      message: "inspect the parser boundary",
    });
    expect(sent).toContainEqual({ type: "subagent.cancel", dispatchId: "ag-7" });
  });

  it("drops empty and oversized steering before it reaches the socket", () => {
    useStore.getState().steerSubagent("ag-7", "   ");
    useStore.getState().steerSubagent("ag-7", "x".repeat(4001));
    expect(sent).toHaveLength(0);
  });
});

describe("store: respondPermission carries the remember flag", () => {
  beforeEach(() => {
    resetStore();
    // Inject a pending permission on the active tab (as routeFrame would).
    useStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        tabs: s.tabs.tabs.map((t, i) =>
          i === 0
            ? {
                ...t,
                pendingPermission: {
                  requestId: "p1",
                  request: {
                    toolName: "run_command",
                    permission: "execute",
                    description: "Run a command",
                    command: "ls",
                  },
                },
              }
            : t,
        ),
      },
    }));
    // Ensure the active tab has a ws client registered (so send() is captured).
    useStore.getState().connect();
  });

  it("allow-for-session sends remember:'session'", () => {
    useStore.getState().respondPermission(true, "session");
    const resp = sent.find((f) => f.type === "permission.response");
    expect(resp).toEqual({ type: "permission.response", requestId: "p1", approved: true, remember: "session" });
    expect(activeTab(useStore.getState().tabs).pendingPermission).toBeNull();
  });

  it("allow-once omits remember", () => {
    useStore.getState().respondPermission(true);
    const resp = sent.find((f) => f.type === "permission.response");
    expect(resp).toEqual({ type: "permission.response", requestId: "p1", approved: true });
  });

  it("deny sends approved:false", () => {
    useStore.getState().respondPermission(false);
    const resp = sent.find((f) => f.type === "permission.response");
    expect(resp).toEqual({ type: "permission.response", requestId: "p1", approved: false });
  });
});

describe("store: respondPermission with selectedHunks", () => {
  beforeEach(() => {
    resetStore();
    useStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        tabs: s.tabs.tabs.map((t, i) =>
          i === 0
            ? {
                ...t,
                pendingPermission: {
                  requestId: "p2",
                  request: {
                    toolName: "apply_patch",
                    permission: "write",
                    description: "Apply edits",
                    path: "src/a.ts",
                  },
                },
              }
            : t,
        ),
      },
    }));
    useStore.getState().connect();
  });

  it("sends selectedHunks in the frame when provided", () => {
    useStore.getState().respondPermission(true, undefined, [0, 2]);
    const resp = sent.find((f) => f.type === "permission.response");
    expect(resp).toEqual({
      type: "permission.response",
      requestId: "p2",
      approved: true,
      selectedHunks: [0, 2],
    });
  });

  it("omits selectedHunks when not provided", () => {
    useStore.getState().respondPermission(true);
    const resp = sent.find((f) => f.type === "permission.response");
    expect(resp).toEqual({ type: "permission.response", requestId: "p2", approved: true });
    expect((resp as Record<string, unknown>).selectedHunks).toBeUndefined();
  });

  it("can combine selectedHunks with remember:session", () => {
    useStore.getState().respondPermission(true, "session", [1]);
    const resp = sent.find((f) => f.type === "permission.response");
    expect(resp).toEqual({
      type: "permission.response",
      requestId: "p2",
      approved: true,
      remember: "session",
      selectedHunks: [1],
    });
  });
});

describe("store: loop mode", () => {
  beforeEach(() => {
    resetStore();
    useStore.getState().connect();
  });

  it("startLoop sends a loop frame, marks running, and clears prior progress", () => {
    useStore.getState().startLoop({
      task: "fix it",
      verifyCommand: "pnpm test",
      maxIterations: 5,
      budget: 1.5,
      requirementMode: "confirm",
    });
    const loop = sent.find((f) => f.type === "loop");
    expect(loop).toMatchObject({
      type: "loop",
      task: "fix it",
      verifyCommand: "pnpm test",
      maxIterations: 5,
      budget: 1.5,
      requirementMode: "confirm",
    });
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(true);
    expect(tab.loopRunning).toBe(true);
    expect(tab.loop.events).toEqual([]);
    expect(tab.loop.result).toBeNull();
  });

  it("omits maxIterations/budget when not provided", () => {
    useStore.getState().startLoop({ task: "t", verifyCommand: "v" });
    const loop = sent.find((f) => f.type === "loop") as Record<string, unknown>;
    expect(loop.maxIterations).toBeUndefined();
    expect(loop.budget).toBeUndefined();
  });

  it("resumeLoop preserves completed progress until the server accepts it", () => {
    lastHandlers!.onFrame({
      type: "loop.event",
      event: {
        type: "loop.done",
        result: {
          status: "exhausted",
          iterations: 1,
          costUsd: 0.1,
          sessionId: "s",
          finalVerify: { code: 1, output: "no" },
        },
      },
    });
    const completed = activeTab(useStore.getState().tabs).loop;
    useStore
      .getState()
      .resumeLoop({ loopId: "loop-abc", addedIterations: 3, addedBudget: 0.5, approveRequirements: true });
    expect(sent.find((f) => (f as { type: string }).type === "loop.resume")).toMatchObject({
      type: "loop.resume",
      loopId: "loop-abc",
      addedIterations: 3,
      addedBudget: 0.5,
      approveRequirements: true,
    });
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(true);
    expect(tab.loopRunning).toBe(true);
    expect(tab.loop).toEqual(completed);
    expect(tab.loopResetPending).toBe(true);

    lastHandlers!.onFrame({ type: "loop.event", event: { type: "iteration.start", iteration: 2 } });
    expect(activeTab(useStore.getState().tabs).loop).toMatchObject({
      events: [{ type: "iteration.start", iteration: 2 }],
      result: null,
    });
    expect(activeTab(useStore.getState().tabs).loopResetPending).toBe(false);
  });

  it("preserves completed loop controls when resume is rejected", () => {
    lastHandlers!.onFrame({
      type: "loop.event",
      event: {
        type: "loop.done",
        result: {
          status: "exhausted",
          iterations: 1,
          costUsd: 0.1,
          sessionId: "s",
          finalVerify: { code: 1, output: "no" },
        },
      },
    });
    const completed = activeTab(useStore.getState().tabs).loop;
    useStore.getState().resumeLoop({ loopId: "loop-abc" });
    lastHandlers!.onFrame({ type: "error", code: "loop_error", message: "cannot resume" });
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.loop).toEqual(completed);
    expect(tab.chat.running).toBe(false);
    expect(tab.loopRunning).toBe(false);
    expect(tab.loopResetPending).toBe(false);
  });

  it("disconnect interrupts a run and clears pending prompts", () => {
    useStore.getState().sendTask("work");
    lastHandlers!.onFrame({
      type: "permission.request",
      requestId: "p-disconnect",
      request: { toolName: "run_command", permission: "execute", description: "run", command: "pnpm test" },
    });
    lastHandlers!.onState("disconnected");
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(false);
    expect(tab.pendingPermission).toBeNull();
    expect(tab.pendingQuestion).toBeNull();
    expect(tab.wsError).toContain("interrupted");
  });

  it("subscribes from the last run sequence after reconnect and applies the terminal replay", () => {
    useStore.getState().sendTask("work");
    lastHandlers!.onFrame({ type: "run.accepted", runId: "run-replay", status: "queued", seq: 1 });
    lastHandlers!.onFrame({
      type: "event",
      runId: "run-replay",
      seq: 2,
      sessionId: "replay-session",
      event: { type: "session.created", sessionId: "replay-session" },
    });

    lastHandlers!.onState("disconnected");
    lastHandlers!.onState("connected");
    expect(sent.at(-1)).toMatchObject({ type: "subscribe", runId: "run-replay", afterSeq: 2 });
    expect(activeTab(useStore.getState().tabs).chat.running).toBe(true);

    lastHandlers!.onFrame({
      type: "event",
      runId: "run-replay",
      seq: 3,
      sessionId: "replay-session",
      event: { type: "session.failed", error: { code: "cancelled", message: "socket closed" } },
    });
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(false);
    expect(tab.activeRunId).toBeNull();
    expect(tab.runSeq).toBe(0);
    expect(tab.wsError).toBeNull();
  });

  it("generic chat runs do not put LoopPanel into its running state", () => {
    useStore.getState().sendTask("ordinary chat task");
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.chat.running).toBe(true);
    expect(tab.loopRunning).toBe(false);
  });

  it("ignores startLoop with empty task or verify command", () => {
    useStore.getState().startLoop({ task: "   ", verifyCommand: "pnpm test" });
    useStore.getState().startLoop({ task: "fix", verifyCommand: "" });
    expect(sent.find((f) => f.type === "loop")).toBeUndefined();
  });

  it("routes loop.event frames into the active tab's progress", () => {
    useStore.getState().startLoop({ task: "fix", verifyCommand: "pnpm test" });
    lastHandlers!.onFrame({ type: "loop.event", event: { type: "iteration.start", iteration: 1 } });
    lastHandlers!.onFrame({ type: "loop.event", event: { type: "run.completed", iteration: 1, costUsd: 0.01 } });
    lastHandlers!.onFrame({
      type: "loop.event",
      event: { type: "verify", iteration: 1, code: 0, passed: true, output: "ok" },
    });
    lastHandlers!.onFrame({
      type: "loop.event",
      event: {
        type: "loop.done",
        result: {
          status: "passed",
          iterations: 1,
          costUsd: 0.01,
          sessionId: "s",
          finalVerify: { code: 0, output: "ok" },
        },
      },
    });
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.loop.events).toHaveLength(4);
    expect(tab.loop.result?.status).toBe("passed");
  });
});

describe("store: async session actions preserve their target identity", () => {
  beforeEach(resetStore);

  it("backtrack truncates the captured tab instead of the active tab", () => {
    const firstId = activeTab(useStore.getState().tabs).tabId;
    useStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        tabs: s.tabs.tabs.map((tab) => ({
          ...tab,
          chat: {
            ...tab.chat,
            sessionId: "session-a",
            items: [
              { kind: "user" as const, id: 1, text: "keep" },
              { kind: "user" as const, id: 2, text: "drop" },
            ],
          },
        })),
      },
    }));
    useStore.getState().openTab();
    const secondId = activeTab(useStore.getState().tabs).tabId;
    useStore.setState((s) => ({
      tabs: {
        ...s.tabs,
        tabs: s.tabs.tabs.map((tab) =>
          tab.tabId === secondId
            ? { ...tab, chat: { ...tab.chat, items: [{ kind: "user" as const, id: 2, text: "other" }] } }
            : tab,
        ),
      },
    }));

    useStore.getState().truncateAtItem(firstId, "session-a", 2);

    const state = useStore.getState().tabs;
    expect(state.tabs.find((tab) => tab.tabId === firstId)?.chat.items).toHaveLength(1);
    expect(state.tabs.find((tab) => tab.tabId === secondId)?.chat.items).toHaveLength(1);
  });

  it("continued sessions bind to the workspace that produced the response", () => {
    useStore.setState({ activeWorkspaceId: "workspace-b" });

    useStore
      .getState()
      .continueSession(
        { id: "session-a", task: "continue me", mode: "edit", status: "completed", createdAt: "now", updatedAt: "now" },
        [],
        "workspace-a",
      );

    expect(activeTab(useStore.getState().tabs).ws).toBe("workspace-a");
    expect(activeTab(useStore.getState().tabs).chat.sessionId).toBe("session-a");
  });
});

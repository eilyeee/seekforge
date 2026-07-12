import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, WsClient, WsClientHandlers } from "./lib/ws-types";

// Capture every frame the store sends, and let tests drive the onFrame handler.
const sent: ClientFrame[] = [];
let lastHandlers: (WsClientHandlers & { getToken: () => string }) | undefined;
let acceptSend = true;

vi.mock("./lib/ws", () => ({
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
  },
  ApiError: MockApiError,
  setTokenProvider: () => {},
  setWorkspaceProvider: () => {},
}));

const { useStore } = await import("./store");
const { activeTab } = await import("./lib/tabs");

function resetStore(): void {
  sent.length = 0;
  acceptSend = true;
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
    useStore.getState().startLoop({ task: "fix it", verifyCommand: "pnpm test", maxIterations: 5, budget: 1.5 });
    const loop = sent.find((f) => f.type === "loop");
    expect(loop).toMatchObject({
      type: "loop",
      task: "fix it",
      verifyCommand: "pnpm test",
      maxIterations: 5,
      budget: 1.5,
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
        result: { status: "exhausted", iterations: 1, costUsd: 0.1, sessionId: "s", finalVerify: { code: 1, output: "no" } },
      },
    });
    const completed = activeTab(useStore.getState().tabs).loop;
    useStore.getState().resumeLoop({ loopId: "loop-abc", addedIterations: 3, addedBudget: 0.5 });
    expect(sent.find((f) => (f as { type: string }).type === "loop.resume")).toMatchObject({
      type: "loop.resume",
      loopId: "loop-abc",
      addedIterations: 3,
      addedBudget: 0.5,
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
        result: { status: "exhausted", iterations: 1, costUsd: 0.1, sessionId: "s", finalVerify: { code: 1, output: "no" } },
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
        result: { status: "passed", iterations: 1, costUsd: 0.01, sessionId: "s", finalVerify: { code: 0, output: "ok" } },
      },
    });
    const tab = activeTab(useStore.getState().tabs);
    expect(tab.loop.events).toHaveLength(4);
    expect(tab.loop.result?.status).toBe("passed");
  });
});

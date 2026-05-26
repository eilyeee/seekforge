import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, WsClient, WsClientHandlers } from "./lib/ws-types";

// Capture every frame the store sends, and let tests drive the onFrame handler.
const sent: ClientFrame[] = [];
let lastHandlers: (WsClientHandlers & { getToken: () => string }) | undefined;

vi.mock("./lib/ws", () => ({
  createWsClient: (handlers: WsClientHandlers & { getToken: () => string }): WsClient => {
    lastHandlers = handlers;
    return {
      send: (frame: ClientFrame) => {
        sent.push(frame);
      },
      close: () => {},
    };
  },
}));

// The store calls api.workspaces()/config() at module load; stub them to no-ops
// (the promises resolve to empty so onboarding/workspace boot is inert).
vi.mock("./lib/api", () => ({
  api: {
    workspaces: () => Promise.resolve([]),
    config: () => Promise.resolve({}),
  },
  setTokenProvider: () => {},
  setWorkspaceProvider: () => {},
}));

const { useStore } = await import("./store");
const { activeTab } = await import("./lib/tabs");

function resetStore(): void {
  sent.length = 0;
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
            }
          : t,
      ),
    },
  }));
}

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

// Reference lastHandlers so unused-var lint stays quiet; the handler hook is
// exercised indirectly when a real frame round-trip test is added later.
void lastHandlers;

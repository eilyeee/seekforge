import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./events";
import type { ServerFrame } from "./ws-types";
import {
  activeTab,
  closeTab,
  initialTabsState,
  openTab,
  routeFrame,
  switchTab,
  titleFromTask,
  updateTab,
  worktreeLabel,
  type TabsState,
} from "./tabs";

function threeTabs(): TabsState {
  return openTab(openTab(initialTabsState())); // t1, t2, t3 — t3 active
}

const event = (e: StreamEvent): ServerFrame => ({ type: "event", sessionId: "s-x", event: e });

describe("open/close/switch", () => {
  it("starts with a single active tab", () => {
    const s = initialTabsState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(s.tabs[0]!.tabId);
  });

  it("openTab appends a fresh tab and activates it", () => {
    const s = openTab(initialTabsState());
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe(s.tabs[1]!.tabId);
    expect(s.tabs[0]!.tabId).not.toBe(s.tabs[1]!.tabId);
    expect(activeTab(s).chat.items).toHaveLength(0);
  });

  it("switchTab activates an existing tab and ignores unknown ids", () => {
    const s = threeTabs();
    const switched = switchTab(s, "t1");
    expect(switched.activeTabId).toBe("t1");
    expect(switchTab(s, "nope")).toBe(s);
  });

  it("closing a background tab keeps the active one", () => {
    const s = closeTab(threeTabs(), "t1");
    expect(s.tabs.map((t) => t.tabId)).toEqual(["t2", "t3"]);
    expect(s.activeTabId).toBe("t3");
  });

  it("closing the active tab activates its neighbour", () => {
    const s = switchTab(threeTabs(), "t2");
    const next = closeTab(s, "t2");
    expect(next.activeTabId).toBe("t3");
    const last = closeTab(switchTab(next, "t3"), "t3");
    expect(last.activeTabId).toBe("t1");
  });

  it("closing the last remaining tab leaves a fresh one", () => {
    const s = closeTab(initialTabsState(), "t1");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.tabId).not.toBe("t1");
    expect(s.activeTabId).toBe(s.tabs[0]!.tabId);
  });
});

describe("per-tab workspace binding", () => {
  it("the initial tab binds to the given workspace (empty by default)", () => {
    expect(initialTabsState().tabs[0]!.ws).toBe("");
    expect(initialTabsState("ws-a").tabs[0]!.ws).toBe("ws-a");
  });

  it("openTab binds the new tab to the active workspace", () => {
    const s = openTab(initialTabsState("ws-a"), "ws-b");
    expect(s.tabs[0]!.ws).toBe("ws-a"); // the original tab keeps its binding
    expect(activeTab(s).ws).toBe("ws-b"); // the new tab uses the active workspace
  });

  it("a tab keeps its workspace binding regardless of later switches", () => {
    // Tab opened in ws-a stays bound to ws-a even after a new tab opens in ws-b.
    let s = initialTabsState("ws-a");
    s = openTab(s, "ws-b");
    s = switchTab(s, s.tabs[0]!.tabId);
    expect(activeTab(s).ws).toBe("ws-a");
  });

  it("closing the last tab preserves its workspace binding on the replacement", () => {
    const s = closeTab(initialTabsState("ws-a"), "t1");
    expect(s.tabs[0]!.ws).toBe("ws-a");
  });
});

describe("worktree tabs", () => {
  const wt = { id: "wt-fix-login", branch: "seekforge/fix-login", base: "ws-a", dirty: false };

  it("openTab seeds the worktree binding; ws is the worktree workspace id", () => {
    const s = openTab(initialTabsState("ws-a"), wt.id, { worktree: wt });
    const tab = activeTab(s);
    expect(tab.ws).toBe("wt-fix-login"); // chat WS binds ws=wt-… automatically
    expect(tab.worktree).toEqual(wt);
    expect(s.tabs[0]!.worktree).toBeUndefined(); // existing tabs untouched
  });

  it("worktreeLabel is the slug part of the branch", () => {
    expect(worktreeLabel(wt)).toBe("fix-login");
    expect(worktreeLabel({ ...wt, branch: "other/name" })).toBe("other/name");
  });

  it("updateTab toggles the dirty flag without touching the rest", () => {
    let s = openTab(initialTabsState("ws-a"), wt.id, { worktree: wt });
    s = updateTab(s, s.activeTabId, { worktree: { ...wt, dirty: true } });
    expect(activeTab(s).worktree).toEqual({ ...wt, dirty: true });
    expect(activeTab(s).ws).toBe("wt-fix-login");
  });

  it("closing the last remaining worktree tab falls back to the BASE workspace", () => {
    // The worktree workspace may already be deleted — a fresh tab must not
    // keep pointing at it.
    let s = closeTab(initialTabsState("ws-a"), "t1"); // fresh state, then rebuild:
    s = openTab(initialTabsState("ws-a"), wt.id, { worktree: wt });
    s = closeTab(s, "t1"); // drop the plain tab; only the worktree tab remains
    s = closeTab(s, s.tabs[0]!.tabId); // close the worktree tab itself
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.ws).toBe("ws-a");
    expect(s.tabs[0]!.worktree).toBeUndefined();
  });

  it("closing a background worktree tab leaves the others untouched", () => {
    let s = openTab(initialTabsState("ws-a"), wt.id, { worktree: wt });
    s = openTab(s, "ws-a");
    const worktreeTabId = s.tabs[1]!.tabId;
    s = closeTab(s, worktreeTabId);
    expect(s.tabs.map((t) => t.worktree)).toEqual([undefined, undefined]);
    expect(s.activeTabId).toBe(s.tabs[1]!.tabId);
  });
});

describe("titleFromTask", () => {
  it("takes the first words and truncates", () => {
    expect(titleFromTask("Fix the bug")).toBe("Fix the bug");
    expect(titleFromTask("  a  b  ")).toBe("a b");
    const long = titleFromTask("seven words make a very long title indeed");
    expect(long.length).toBeLessThanOrEqual(28);
    expect(titleFromTask("   ")).toBe("new tab");
  });
});

describe("routeFrame", () => {
  it("routes events to the addressed tab only", () => {
    const s = threeTabs();
    const next = routeFrame(s, "t2", event({ type: "session.created", sessionId: "s-abc" }));
    expect(next.tabs.find((t) => t.tabId === "t2")!.chat.sessionId).toBe("s-abc");
    expect(next.tabs.find((t) => t.tabId === "t1")!.chat.sessionId).toBeNull();
    expect(next.tabs.find((t) => t.tabId === "t3")!.chat.sessionId).toBeNull();
  });

  it("ignores frames for unknown tabs", () => {
    const s = threeTabs();
    expect(routeFrame(s, "gone", { type: "idle" })).toBe(s);
  });

  it("permission.request lands on the addressed tab", () => {
    const frame: ServerFrame = {
      type: "permission.request",
      requestId: "p1",
      request: { toolName: "run_command", permission: "execute", description: "run it", command: "pnpm test" },
    };
    const next = routeFrame(threeTabs(), "t1", frame);
    expect(next.tabs.find((t) => t.tabId === "t1")!.pendingPermission?.requestId).toBe("p1");
    expect(next.tabs.find((t) => t.tabId === "t3")!.pendingPermission).toBeNull();
  });

  it("idle stops the run and clears the pending permission", () => {
    let s = updateTab(threeTabs(), "t2", (tab) => ({
      chat: { ...tab.chat, running: true },
      pendingPermission: { requestId: "p9", request: { toolName: "x", permission: "write", description: "d" } },
    }));
    s = routeFrame(s, "t2", { type: "idle" });
    const t2 = s.tabs.find((t) => t.tabId === "t2")!;
    expect(t2.chat.running).toBe(false);
    expect(t2.pendingPermission).toBeNull();
  });

  it("question.request lands on the addressed tab", () => {
    const frame: ServerFrame = {
      type: "question.request",
      id: "q1",
      question: "Which approach?",
      options: ["A", "B"],
    };
    const next = routeFrame(threeTabs(), "t2", frame);
    expect(next.tabs.find((t) => t.tabId === "t2")!.pendingQuestion).toEqual({
      id: "q1",
      question: "Which approach?",
      options: ["A", "B"],
    });
    expect(next.tabs.find((t) => t.tabId === "t1")!.pendingQuestion).toBeNull();
  });

  it("idle clears the pending question", () => {
    let s = updateTab(threeTabs(), "t2", {
      pendingQuestion: { id: "q2", question: "?", options: ["x"] },
    });
    s = routeFrame(s, "t2", { type: "idle" });
    expect(s.tabs.find((t) => t.tabId === "t2")!.pendingQuestion).toBeNull();
  });

  it("non-busy errors stop the spinner; busy keeps it", () => {
    const base = updateTab(threeTabs(), "t1", (tab) => ({ chat: { ...tab.chat, running: true } }));
    const bad = routeFrame(base, "t1", { type: "error", code: "unknown_session", message: "?" });
    expect(bad.tabs.find((t) => t.tabId === "t1")!.chat.running).toBe(false);
    expect(bad.tabs.find((t) => t.tabId === "t1")!.wsError).toBe("unknown_session: ?");
    const busy = routeFrame(base, "t1", { type: "error", code: "busy", message: "running" });
    expect(busy.tabs.find((t) => t.tabId === "t1")!.chat.running).toBe(true);
  });

  it("session.completed on a plan run flips planPending → planReady", () => {
    const report = {
      summary: "plan",
      changedFiles: [],
      commandsRun: [],
      verification: "plan only",
      usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0 },
    };
    let s = updateTab(threeTabs(), "t3", { planPending: true });
    s = routeFrame(s, "t3", event({ type: "session.completed", report }));
    const t3 = s.tabs.find((t) => t.tabId === "t3")!;
    expect(t3.planPending).toBe(false);
    expect(t3.planReady).toBe(true);
    expect(t3.chat.running).toBe(false);

    // A non-plan completion does not offer Execute plan.
    const s2 = routeFrame(threeTabs(), "t3", event({ type: "session.completed", report }));
    expect(s2.tabs.find((t) => t.tabId === "t3")!.planReady).toBe(false);

    // A failed plan run clears planPending without offering execution.
    let s3 = updateTab(threeTabs(), "t3", { planPending: true });
    s3 = routeFrame(s3, "t3", event({ type: "session.failed", error: { code: "x", message: "boom" } }));
    expect(s3.tabs.find((t) => t.tabId === "t3")!.planPending).toBe(false);
    expect(s3.tabs.find((t) => t.tabId === "t3")!.planReady).toBe(false);
  });
});

describe("header-control state (model/thinking/effort)", () => {
  it("fresh tabs default to config-driven controls", () => {
    const tab = activeTab(initialTabsState());
    expect(tab.model).toBe("");
    expect(tab.thinking).toBeNull();
    expect(tab.reasoningEffort).toBe("high");
  });

  it("controls are per tab and survive tab switches", () => {
    let s = threeTabs(); // t3 active
    s = updateTab(s, "t3", { model: "deepseek-v4-pro", thinking: true, reasoningEffort: "max" });
    s = switchTab(s, "t1");
    expect(activeTab(s).model).toBe(""); // t1 untouched
    expect(s.tabs.find((t) => t.tabId === "t3")).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: true,
      reasoningEffort: "max",
    });
  });
});

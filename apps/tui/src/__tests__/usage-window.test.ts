import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@seekforge/shared";
import { chatReducer, initialState, type ChatState } from "../model.js";

const usage = (costUsd: number) => ({ costUsd, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 });
/** A run's closing report: `usage` is this run, `sessionUsage` the whole session. */
const report = (runCost: number, sessionCost = runCost) =>
  ({
    type: "session.completed",
    report: { usage: usage(runCost), sessionUsage: usage(sessionCost) },
  }) as unknown as AgentEvent;
/** A pre-two-window server, which sends only the run total. */
const legacyReport = (runCost: number) =>
  ({ type: "session.completed", report: { usage: usage(runCost) } }) as unknown as AgentEvent;
const live = (runCost: number, sessionCost: number) =>
  ({ type: "usage.updated", usage: usage(runCost), sessionUsage: usage(sessionCost) }) as unknown as AgentEvent;
const created = (sessionId: string) => ({ type: "session.created", sessionId }) as unknown as AgentEvent;
const failed = () => ({ type: "session.failed", error: { code: "network", message: "down" } }) as unknown as AgentEvent;

function reduce(state: ChatState, ...events: AgentEvent[]): ChatState {
  return events.reduce((s, event) => chatReducer(s, { type: "event", event }), state);
}

/**
 * Every usage event carries two cumulative windows: `usage` is the current RUN,
 * `sessionUsage` the whole session including the runs a resume inherited. Turns
 * 2+ resume the same session, so a tab total built from the run window is wrong
 * in both directions — adding re-bills every earlier turn, replacing forgets
 * them. `totalUsage.costUsd` is what the tab's `costBudgetUsd` check reads, so
 * forgetting them makes the budget too permissive, which is the worse failure.
 */
describe("tab usage counts a resumed session once", () => {
  it("takes the session window, neither adding nor dropping earlier turns", () => {
    let state = reduce(initialState("deepseek-chat"), created("s1"), report(0.01));
    expect(state.totalUsage.costUsd).toBeCloseTo(0.01);
    // Turn 2 resumes s1: it spent 0.02, and the session now stands at 0.03.
    state = reduce(state, created("s1"), report(0.02, 0.03));
    expect(state.totalUsage.costUsd, "turn 1 billed twice (0.04) or dropped (0.02)").toBeCloseTo(0.03);
  });

  it("still accumulates across genuinely different sessions", () => {
    const state = reduce(initialState("deepseek-chat"), created("s1"), report(0.03), created("s2"), report(0.05));
    expect(state.totalUsage.costUsd).toBeCloseTo(0.08);
  });

  it("counts a session once when /resume or /fork comes back to it", () => {
    // s1 spends 0.01, s2 spends 0.02, then /resume s1 adds 0.005 to s1 —
    // 0.035 in total. A single running carry cannot express this: it has
    // already absorbed s1's 0.01, so s1's own window bills that 0.01 a second
    // time (0.045), and skipping the settle instead drops s2 (0.015).
    let state = reduce(initialState("deepseek-chat"), created("s1"), report(0.01));
    state = reduce(state, created("s2"), report(0.02));
    expect(state.totalUsage.costUsd).toBeCloseTo(0.03);
    state = chatReducer(state, { type: "set-session", sessionId: "s1" });
    state = reduce(state, created("s1"), report(0.005, 0.015));
    expect(state.totalUsage.costUsd, "s1 billed twice (0.045) or s2 dropped (0.015)").toBeCloseTo(0.035);
  });

  it("settles spend live, so a failed turn still counts against the budget", () => {
    let state = reduce(initialState("deepseek-chat"), created("s1"), report(0.01));
    state = reduce(state, live(0.004, 0.014), failed());
    expect(state.totalUsage.costUsd, "a failed run still spent what it spent").toBeCloseTo(0.014);
    // The next run resumes the same session and starts from that total.
    state = reduce(state, live(0.001, 0.015));
    expect(state.totalUsage.costUsd).toBeCloseTo(0.015);
  });

  it("never reports less than the run window, whatever the server sends", () => {
    // The budget may only ever trip at the same point or earlier. A server that
    // omits `sessionUsage` falls back to summing run windows — an approximation,
    // but never an undercount of the runs this tab has seen.
    const state = reduce(initialState("deepseek-chat"), created("s1"), legacyReport(0.01), legacyReport(0.02));
    expect(state.totalUsage.costUsd).toBeCloseTo(0.03);
  });
});

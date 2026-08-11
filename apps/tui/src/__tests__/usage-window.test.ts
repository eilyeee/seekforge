import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@seekforge/shared";
import { chatReducer, initialState, type ChatState } from "../model.js";

const usage = (costUsd: number) => ({ costUsd, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 });
const report = (costUsd: number) =>
  ({ type: "session.completed", report: { usage: usage(costUsd) } }) as unknown as AgentEvent;
const created = (sessionId: string) => ({ type: "session.created", sessionId }) as unknown as AgentEvent;

function reduce(state: ChatState, ...events: AgentEvent[]): ChatState {
  return events.reduce((s, event) => chatReducer(s, { type: "event", event }), state);
}

/**
 * `session.completed` carries the WHOLE session's usage — core builds it as
 * `addUsage(priorUsage, …)` where `priorUsage` is what the persisted session
 * already spent — while turns 2+ resume that same session. Summing the reports
 * re-billed every earlier turn, and `totalUsage.costUsd` is what the tab's
 * `costBudgetUsd` check reads, so the budget stopped runs early.
 */
describe("tab usage counts a resumed session once", () => {
  it("replaces the session's share rather than adding it", () => {
    let state = reduce(initialState("deepseek-chat"), created("s1"), report(0.01));
    expect(state.totalUsage.costUsd).toBeCloseTo(0.01);
    // Turn 2 resumes s1, so its report is turn 1 (0.01) plus turn 2 (0.02).
    state = reduce(state, created("s1"), report(0.03));
    expect(state.totalUsage.costUsd, "turn 1 must not be billed twice").toBeCloseTo(0.03);
  });

  it("still accumulates across genuinely different sessions", () => {
    const state = reduce(initialState("deepseek-chat"), created("s1"), report(0.03), created("s2"), report(0.05));
    expect(state.totalUsage.costUsd).toBeCloseTo(0.08);
  });
});

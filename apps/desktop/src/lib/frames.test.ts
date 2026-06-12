import { describe, expect, it } from "vitest";
import { buildExecutePlanFrame, buildSendFrame, buildStartFrame, overridesOf, EXECUTE_PLAN_TASK } from "./frames";

describe("buildStartFrame", () => {
  it("plan mode sends mode:ask with the plan flag", () => {
    expect(buildStartFrame("do it", "plan", "confirm")).toEqual({
      type: "start",
      task: "do it",
      mode: "ask",
      approvalMode: "confirm",
      plan: true,
    });
  });

  it("edit/ask send their mode without a plan flag", () => {
    expect(buildStartFrame("do it", "edit", "confirm")).toEqual({
      type: "start",
      task: "do it",
      mode: "edit",
      approvalMode: "confirm",
    });
    expect(buildStartFrame("why?", "ask", "confirm")).toEqual({
      type: "start",
      task: "why?",
      mode: "ask",
      approvalMode: "confirm",
    });
  });

  it("threads the chosen approvalMode (confirm/acceptEdits/auto) into the frame", () => {
    expect(buildStartFrame("go", "edit", "auto")).toMatchObject({ approvalMode: "auto" });
    expect(buildStartFrame("go", "edit", "acceptEdits")).toMatchObject({ approvalMode: "acceptEdits" });
    expect(buildStartFrame("go", "plan", "auto")).toMatchObject({ approvalMode: "auto", plan: true });
    expect(buildStartFrame("go", "plan", "acceptEdits")).toMatchObject({
      approvalMode: "acceptEdits",
      plan: true,
    });
  });

  it("includes ws when a workspace id is given, omits it when empty", () => {
    expect(buildStartFrame("go", "edit", "confirm", "ws-a")).toMatchObject({ ws: "ws-a" });
    expect(buildStartFrame("go", "plan", "confirm", "ws-a")).toMatchObject({ ws: "ws-a", plan: true });
    // An empty/omitted id leaves ws off the frame (server -> default workspace).
    expect(buildStartFrame("go", "edit", "confirm", "")).not.toHaveProperty("ws");
    expect(buildStartFrame("go", "edit", "confirm")).not.toHaveProperty("ws");
  });
});

describe("buildExecutePlanFrame", () => {
  it("continues the session in edit mode with the canned task", () => {
    expect(buildExecutePlanFrame("s-1")).toEqual({
      type: "send",
      sessionId: "s-1",
      task: EXECUTE_PLAN_TASK,
      mode: "edit",
    });
    expect(EXECUTE_PLAN_TASK).toBe(
      "Execute the plan you produced above, step by step. Make the changes and run the verification.",
    );
  });

  it("carries the tab's workspace id when present", () => {
    expect(buildExecutePlanFrame("s-1", "ws-b")).toMatchObject({ ws: "ws-b" });
    expect(buildExecutePlanFrame("s-1")).not.toHaveProperty("ws");
  });
});

describe("overridesOf (header controls -> frame fields)", () => {
  it("untouched controls produce no fields (server config decides)", () => {
    expect(overridesOf({ model: "", thinking: null, reasoningEffort: "high", outputStyle: "" })).toEqual({});
    expect(overridesOf({ model: "   ", thinking: null, reasoningEffort: "max", outputStyle: "default" })).toEqual(
      {},
    );
  });

  it("a non-empty model is trimmed and sent", () => {
    expect(
      overridesOf({ model: " deepseek-v4-pro ", thinking: null, reasoningEffort: "high", outputStyle: "" }),
    ).toEqual({
      model: "deepseek-v4-pro",
    });
  });

  it("thinking on sends thinking AND the effort; thinking off sends only thinking:false", () => {
    expect(overridesOf({ model: "", thinking: true, reasoningEffort: "max", outputStyle: "" })).toEqual({
      thinking: true,
      reasoningEffort: "max",
    });
    expect(overridesOf({ model: "", thinking: false, reasoningEffort: "max", outputStyle: "" })).toEqual({
      thinking: false,
    });
  });

  it("a non-default output style is sent; default/empty is omitted", () => {
    expect(
      overridesOf({ model: "", thinking: null, reasoningEffort: "high", outputStyle: "concise" }),
    ).toEqual({ outputStyle: "concise" });
    expect(
      overridesOf({ model: "", thinking: null, reasoningEffort: "high", outputStyle: "default" }),
    ).toEqual({});
  });
});

describe("frame builders carry per-run overrides", () => {
  const overrides = { model: "deepseek-v4-pro", thinking: true, reasoningEffort: "max" } as const;

  it("buildStartFrame spreads overrides into the frame (plan mode too)", () => {
    expect(buildStartFrame("go", "edit", "confirm", "", overrides)).toMatchObject(overrides);
    expect(buildStartFrame("go", "plan", "confirm", "ws-a", overrides)).toMatchObject({
      ...overrides,
      plan: true,
      ws: "ws-a",
    });
    expect(buildStartFrame("go", "edit", "confirm")).not.toHaveProperty("model");
  });

  it("buildSendFrame carries approvalMode + (edit/ask) mode and overrides per message", () => {
    expect(buildSendFrame("s-1", "more", "auto", "edit", "ws-a", overrides)).toEqual({
      type: "send",
      sessionId: "s-1",
      task: "more",
      approvalMode: "auto",
      mode: "edit",
      ws: "ws-a",
      ...overrides,
    });
    // "plan" is start-only — it is never sent as a follow-up mode.
    expect(buildSendFrame("s-1", "more", "confirm", "plan")).toEqual({
      type: "send",
      sessionId: "s-1",
      task: "more",
      approvalMode: "confirm",
    });
    expect(buildExecutePlanFrame("s-1", "", { thinking: false })).toMatchObject({ thinking: false });
  });
});

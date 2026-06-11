import { describe, expect, it } from "vitest";
import { buildExecutePlanFrame, buildStartFrame, EXECUTE_PLAN_TASK } from "./frames";

describe("buildStartFrame", () => {
  it("plan mode sends mode:ask with the plan flag", () => {
    expect(buildStartFrame("do it", "plan", false)).toEqual({
      type: "start",
      task: "do it",
      mode: "ask",
      approvalMode: "confirm",
      plan: true,
    });
  });

  it("edit/ask send their mode without a plan flag", () => {
    expect(buildStartFrame("do it", "edit", false)).toEqual({
      type: "start",
      task: "do it",
      mode: "edit",
      approvalMode: "confirm",
    });
    expect(buildStartFrame("why?", "ask", false)).toEqual({
      type: "start",
      task: "why?",
      mode: "ask",
      approvalMode: "confirm",
    });
  });

  it("auto-approve maps to approvalMode auto", () => {
    expect(buildStartFrame("go", "edit", true)).toMatchObject({ approvalMode: "auto" });
    expect(buildStartFrame("go", "plan", true)).toMatchObject({ approvalMode: "auto", plan: true });
  });

  it("includes ws when a workspace id is given, omits it when empty", () => {
    expect(buildStartFrame("go", "edit", false, "ws-a")).toMatchObject({ ws: "ws-a" });
    expect(buildStartFrame("go", "plan", false, "ws-a")).toMatchObject({ ws: "ws-a", plan: true });
    // An empty/omitted id leaves ws off the frame (server -> default workspace).
    expect(buildStartFrame("go", "edit", false, "")).not.toHaveProperty("ws");
    expect(buildStartFrame("go", "edit", false)).not.toHaveProperty("ws");
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

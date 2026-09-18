import { describe, expect, it } from "vitest";
import { allowedToolsForTaskProfile, resolveTaskExecution, toolsForTaskProfile } from "../../src/agent/task-profile.js";

describe("interactive task profiles", () => {
  it("keeps ordinary conversation concise and read-only", () => {
    expect(resolveTaskExecution("What does this repository do?", "auto")).toEqual({
      mode: "ask",
      profile: "conversation",
    });
    expect(toolsForTaskProfile("conversation")).not.toContain("run_command");
    expect(toolsForTaskProfile("conversation")).not.toContain("apply_patch");
  });

  it("keeps read-only checks out of an edit workflow while permitting safe probes", () => {
    expect(resolveTaskExecution("Run the focused tests", "auto")).toEqual({ mode: "ask", profile: "inspection" });
    expect(resolveTaskExecution("检查当前认证状态", "auto")).toEqual({ mode: "ask", profile: "inspection" });
    expect(toolsForTaskProfile("inspection")).toContain("run_command");
    expect(toolsForTaskProfile("inspection")).not.toContain("apply_patch");
  });

  it("distinguishes focused edits from substantial implementation", () => {
    expect(resolveTaskExecution("Fix the typo in the README", "auto")).toEqual({
      mode: "edit",
      profile: "quick-edit",
    });
    expect(resolveTaskExecution("全面重构认证模块，并且补全测试和文档", "auto")).toEqual({
      mode: "edit",
      profile: "implementation",
    });
    expect(resolveTaskExecution("全做", "auto")).toEqual({ mode: "edit", profile: "implementation" });
  });

  it("honors explicit ask/edit and plan choices", () => {
    expect(resolveTaskExecution("fix it", "ask")).toEqual({ mode: "ask", profile: "inspection" });
    expect(resolveTaskExecution("what is this?", "edit")).toEqual({ mode: "edit", profile: "implementation" });
    expect(resolveTaskExecution("implement it", "auto", true)).toEqual({ mode: "ask", profile: "inspection" });
  });

  it("only narrows an explicit tool boundary", () => {
    expect(allowedToolsForTaskProfile("quick-edit", ["read_file", "apply_patch", "mcp__private"])).toEqual([
      "read_file",
      "apply_patch",
    ]);
    expect(allowedToolsForTaskProfile("implementation", ["mcp__private"])).toEqual(["mcp__private"]);
  });
});

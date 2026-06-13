import { describe, expect, it } from "vitest";
import { shouldNotify } from "./notify";

const ON = { focused: false, enabled: true };

describe("shouldNotify", () => {
  it("never fires when notifications are disabled", () => {
    expect(shouldNotify({ kind: "permission" }, { focused: false, enabled: false })).toBeNull();
    expect(shouldNotify({ kind: "completed", tabTitle: "t" }, { focused: false, enabled: false })).toBeNull();
    expect(shouldNotify({ kind: "failed", tabTitle: "t" }, { focused: true, enabled: false })).toBeNull();
  });

  it("suppresses permission/question prompts while the window is focused", () => {
    expect(shouldNotify({ kind: "permission" }, { focused: true, enabled: true })).toBeNull();
    expect(shouldNotify({ kind: "question" }, { focused: true, enabled: true })).toBeNull();
  });

  it("still fires completed/failed even while focused (the run is done)", () => {
    expect(shouldNotify({ kind: "completed", tabTitle: "t" }, { focused: true, enabled: true })).not.toBeNull();
    expect(shouldNotify({ kind: "failed", tabTitle: "t" }, { focused: true, enabled: true })).not.toBeNull();
  });

  it("titles a permission request with the tool name", () => {
    expect(shouldNotify({ kind: "permission", tool: "run_command" }, ON)).toEqual({
      title: "SeekForge — permission needed: run_command",
      body: "SeekForge is waiting for your approval.",
    });
  });

  it("falls back to a generic permission title without a tool", () => {
    expect(shouldNotify({ kind: "permission" }, ON)?.title).toBe("SeekForge — permission needed");
  });

  it("maps question to a question prompt when unfocused", () => {
    expect(shouldNotify({ kind: "question" }, ON)).toEqual({
      title: "SeekForge — question",
      body: "SeekForge has a question for you.",
    });
  });

  it("maps completed/failed kinds to their titles with the tab title as body", () => {
    expect(shouldNotify({ kind: "completed", tabTitle: "Fix the bug" }, ON)).toEqual({
      title: "Task finished",
      body: "Fix the bug",
    });
    expect(shouldNotify({ kind: "failed", tabTitle: "Fix the bug" }, ON)).toEqual({
      title: "Task failed",
      body: "Fix the bug",
    });
  });
});

import { describe, expect, it } from "vitest";
import { shouldNotify } from "./notify";

describe("shouldNotify", () => {
  it("never notifies while the document is visible", () => {
    expect(shouldNotify({ kind: "permission" }, false)).toBeNull();
    expect(shouldNotify({ kind: "completed", tabTitle: "t" }, false)).toBeNull();
    expect(shouldNotify({ kind: "failed", tabTitle: "t" }, false)).toBeNull();
  });

  it("notifies on permission requests when hidden", () => {
    expect(shouldNotify({ kind: "permission" }, true)).toEqual({
      title: "SeekForge",
      body: "SeekForge 等待你的确认",
    });
  });

  it("notifies on ask_user questions when hidden", () => {
    expect(shouldNotify({ kind: "question" }, false)).toBeNull();
    expect(shouldNotify({ kind: "question" }, true)).toEqual({
      title: "SeekForge",
      body: "SeekForge 有问题需要你回答",
    });
  });

  it("includes the tab title for completed/failed", () => {
    expect(shouldNotify({ kind: "completed", tabTitle: "Fix the bug" }, true)?.body).toBe("任务完成 — Fix the bug");
    expect(shouldNotify({ kind: "failed", tabTitle: "Fix the bug" }, true)?.body).toBe("任务失败 — Fix the bug");
  });
});

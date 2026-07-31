import { describe, expect, it } from "vitest";
import type { ChatItem } from "./events";
import { groupChatTasks, taskGroupStatus } from "./task-groups";

describe("groupChatTasks", () => {
  it("keeps preamble events and starts one ordered group per user task", () => {
    const items: ChatItem[] = [
      { kind: "notice", id: 1, level: "info", message: "ready" },
      { kind: "user", id: 2, text: "first" },
      { kind: "assistant", id: 3, text: "done", streaming: false },
      {
        kind: "report",
        id: 4,
        report: {
          summary: "done",
          changedFiles: [],
          commandsRun: [],
          verification: "none",
          usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
        },
      },
      { kind: "user", id: 5, text: "second" },
      { kind: "continuing", id: 6, continuation: 1, maxContinuations: 2 },
    ];

    const groups = groupChatTasks(items);
    expect(groups.map((group) => group.key)).toEqual(["task-preamble", "task-2", "task-5"]);
    expect(groups[0]!.items).toEqual([items[0]]);
    expect(groups[1]!.user).toEqual(items[1]);
    expect(taskGroupStatus(groups[1]!)).toBe("completed");
    expect(taskGroupStatus(groups[2]!)).toBe("running");
  });

  it("gives failure precedence over a prior completion event", () => {
    const group = groupChatTasks([
      { kind: "user", id: 1, text: "task" },
      {
        kind: "report",
        id: 2,
        report: {
          summary: "done",
          changedFiles: [],
          commandsRun: [],
          verification: "none",
          usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
        },
      },
      { kind: "failed", id: 3, error: { code: "late", message: "failed" } },
    ])[0]!;
    expect(taskGroupStatus(group)).toBe("failed");
  });

  it("uses historical session state only when the transcript has no terminal event", () => {
    const group = groupChatTasks([
      { kind: "user", id: 1, text: "task" },
      { kind: "assistant", id: 2, text: "answer", streaming: false },
    ])[0]!;
    expect(taskGroupStatus(group)).toBe("running");
    expect(taskGroupStatus(group, "completed")).toBe("completed");
  });
});

import { describe, expect, it } from "vitest";
import { backtrackTargets, truncateItems } from "../backtrack.js";
import type { ChatItem } from "../model.js";

function user(id: string, text: string): ChatItem {
  return { kind: "user", id, text };
}

function assistant(id: string, text: string): ChatItem {
  return { kind: "assistant", id, text, streaming: false };
}

function notice(id: string, text: string): ChatItem {
  return { kind: "notice", id, text, tone: "dim" };
}

const transcript: ChatItem[] = [
  user("u1", "the task"),
  assistant("a1", "answer 0"),
  user("u2", "follow-up 1"),
  notice("n1", "context compacted"),
  assistant("a2", "answer 1"),
  user("u3", "follow-up 2"),
  assistant("a3", "answer 2"),
];

describe("backtrackTargets", () => {
  it("lists user turns excluding the original task, newest last", () => {
    expect(backtrackTargets(transcript)).toEqual([
      { turn: 1, text: "follow-up 1", itemIndex: 2 },
      { turn: 2, text: "follow-up 2", itemIndex: 5 },
    ]);
  });

  it("returns [] for an empty transcript or one with no user items", () => {
    expect(backtrackTargets([])).toEqual([]);
    expect(backtrackTargets([assistant("a1", "hi"), notice("n1", "x")])).toEqual([]);
  });

  it("returns [] when only the original task exists", () => {
    expect(backtrackTargets([user("u1", "the task"), assistant("a1", "ok")])).toEqual([]);
  });
});

describe("truncateItems", () => {
  it("drops the target user item and everything after it", () => {
    const [first, second] = backtrackTargets(transcript);
    expect(truncateItems(transcript, second!).map((it) => it.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "n1",
      "a2",
    ]);
    expect(truncateItems(transcript, first!).map((it) => it.id)).toEqual(["u1", "a1"]);
  });

  it("does not mutate the input", () => {
    const [first] = backtrackTargets(transcript);
    const before = transcript.length;
    truncateItems(transcript, first!);
    expect(transcript).toHaveLength(before);
  });
});

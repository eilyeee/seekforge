import { describe, expect, it } from "vitest";
import { mapToServerTurn, truncateChatAtItem, userTurnOf } from "./backtrack";
import { appendUser, initialChatState, reduceEvent, type ChatState } from "./events";

/** user / assistant / user / assistant / user — items 1..5. */
function chatWithThreeUserTurns(): ChatState {
  let chat = appendUser(initialChatState(), "first task");
  chat = reduceEvent(chat, { type: "model.message", content: "done one" });
  chat = appendUser(chat, "second task");
  chat = reduceEvent(chat, { type: "model.message", content: "done two" });
  chat = appendUser(chat, "third task");
  return { ...chat, sessionId: "s-1" };
}

describe("userTurnOf", () => {
  it("returns the 0-based ordinal among user items plus the total count", () => {
    const chat = chatWithThreeUserTurns();
    const userIds = chat.items.filter((i) => i.kind === "user").map((i) => i.id);
    expect(userTurnOf(chat.items, userIds[0]!)).toEqual({ turn: 0, count: 3 });
    expect(userTurnOf(chat.items, userIds[1]!)).toEqual({ turn: 1, count: 3 });
    expect(userTurnOf(chat.items, userIds[2]!)).toEqual({ turn: 2, count: 3 });
  });

  it("returns null for non-user items and unknown ids", () => {
    const chat = chatWithThreeUserTurns();
    const assistant = chat.items.find((i) => i.kind === "assistant")!;
    expect(userTurnOf(chat.items, assistant.id)).toBeNull();
    expect(userTurnOf(chat.items, 999)).toBeNull();
  });
});

describe("mapToServerTurn", () => {
  it("is the identity when local and server counts match", () => {
    expect(mapToServerTurn(1, 3, 3)).toBe(1);
    expect(mapToServerTurn(2, 3, 3)).toBe(2);
  });

  it("aligns from the END when the server holds extra user messages", () => {
    // e.g. compaction left a summary user message at the top: 4 server turns,
    // 3 local bubbles — the last local bubble is the last server turn.
    expect(mapToServerTurn(2, 3, 4)).toBe(3);
    expect(mapToServerTurn(1, 3, 4)).toBe(2);
  });

  it("can produce non-backtrackable indices the caller must reject", () => {
    expect(mapToServerTurn(0, 3, 3)).toBe(0); // turn 0: never backtrackable
    expect(mapToServerTurn(1, 3, 2)).toBe(0); // fewer server turns than local
  });
});

describe("truncateChatAtItem", () => {
  it("drops the user item and everything after, keeps the session id", () => {
    const chat = chatWithThreeUserTurns();
    const secondUser = chat.items.filter((i) => i.kind === "user")[1]!;
    const truncated = truncateChatAtItem(chat, secondUser.id);
    expect(truncated.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(truncated.sessionId).toBe("s-1");
    expect(truncated.running).toBe(false);
    // nextId is untouched: future items never reuse a dropped id.
    expect(truncated.nextId).toBe(chat.nextId);
  });

  it("returns the state unchanged for an unknown item id", () => {
    const chat = chatWithThreeUserTurns();
    expect(truncateChatAtItem(chat, 999)).toBe(chat);
  });
});

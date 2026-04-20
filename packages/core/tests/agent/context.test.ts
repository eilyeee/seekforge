import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import { clearOldToolResults, compactMessages, estimateMessagesTokens } from "../../src/agent/context.js";

function msg(role: ChatMessage["role"], content: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { role, content, ...extra };
}

function conversation(turns: number, contentSize = 2000): ChatMessage[] {
  const messages: ChatMessage[] = [msg("system", "system prompt"), msg("user", "the task")];
  for (let i = 0; i < turns; i++) {
    messages.push(
      msg("assistant", "", { toolCalls: [{ id: `c${i}`, name: "read_file", argumentsJson: "{}" }] }),
      msg("tool", "x".repeat(contentSize), { toolCallId: `c${i}` }),
    );
  }
  return messages;
}

describe("compactMessages", () => {
  it("returns null when under budget", () => {
    expect(compactMessages(conversation(2), 1_000_000)).toBeNull();
  });

  it("compacts an over-budget conversation below the original size", () => {
    const messages = conversation(30);
    const before = estimateMessagesTokens(messages);
    const result = compactMessages(messages, Math.floor(before / 3));
    expect(result).not.toBeNull();
    expect(estimateMessagesTokens(result!.messages)).toBeLessThan(before);
    expect(result!.droppedTurns).toBeGreaterThan(0);
  });

  it("keeps system prompt and original task at the head", () => {
    const messages = conversation(30);
    const result = compactMessages(messages, 2000)!;
    expect(result.messages[0]!.content).toBe("system prompt");
    expect(result.messages[1]!.content).toBe("the task");
    expect(result.messages[2]!.content).toContain("compacted");
  });

  it("never starts the kept tail on a dangling tool message", () => {
    const messages = conversation(30);
    const result = compactMessages(messages, 2000)!;
    // The first message after the digest must not be a tool result whose
    // assistant tool_calls message was dropped.
    expect(result.messages[3]!.role).not.toBe("tool");
  });
});

describe("clearOldToolResults", () => {
  const CLEARED = '{"ok":true,"note":"[old tool output cleared to save context]"}';

  /** system + N user turns, each turn: user, assistant(toolCall), tool(content). */
  function multiTurn(turns: number, toolContentSize = 1000): ChatMessage[] {
    const messages: ChatMessage[] = [msg("system", "system prompt")];
    for (let i = 0; i < turns; i++) {
      messages.push(
        msg("user", `turn ${i}`),
        msg("assistant", "", { toolCalls: [{ id: `c${i}`, name: "read_file", argumentsJson: "{}" }] }),
        msg("tool", "x".repeat(toolContentSize), { toolCallId: `c${i}` }),
      );
    }
    return messages;
  }

  it("clears only tool results older than the last 2 user turns (default)", () => {
    const messages = multiTurn(4);
    const { messages: out, cleared } = clearOldToolResults(messages);
    // Turns 0 and 1 are older than the last 2 user turns (turns 2 and 3).
    expect(cleared).toBe(2);
    expect(out[3]!.content).toBe(CLEARED); // turn 0 tool
    expect(out[6]!.content).toBe(CLEARED); // turn 1 tool
    expect(out[9]!.content).toBe("x".repeat(1000)); // turn 2 tool kept
    expect(out[12]!.content).toBe("x".repeat(1000)); // turn 3 tool kept
    // Non-tool messages and toolCallId pairing are untouched.
    expect(out[3]!.toolCallId).toBe("c0");
    expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
  });

  it("honors a custom keepLastTurns", () => {
    const { cleared } = clearOldToolResults(multiTurn(4), 1);
    expect(cleared).toBe(3); // everything before the last user turn
    expect(clearOldToolResults(multiTurn(4), 4).cleared).toBe(0);
  });

  it("clears nothing when there are fewer user turns than keepLastTurns", () => {
    const messages = multiTurn(2);
    const res = clearOldToolResults(messages); // exactly 2 turns: nothing is older
    expect(res.cleared).toBe(0);
    expect(res.messages).toBe(messages); // same array back, no copy churn
  });

  it("skips short tool outputs (<= 200 chars)", () => {
    const messages = multiTurn(4, 200);
    expect(clearOldToolResults(messages).cleared).toBe(0);
  });

  it("is pure and idempotent", () => {
    const messages = multiTurn(4);
    const originalContent = messages[3]!.content;
    const first = clearOldToolResults(messages);
    expect(messages[3]!.content).toBe(originalContent); // input untouched
    const second = clearOldToolResults(first.messages);
    expect(second.cleared).toBe(0); // the note is below the threshold
    expect(second.messages).toBe(first.messages);
  });
});

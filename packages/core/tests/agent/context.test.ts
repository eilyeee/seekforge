import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import { compactMessages, estimateMessagesTokens } from "../../src/agent/context.js";

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

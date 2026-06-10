import type { ChatMessage } from "@seekforge/shared";

/** Rough estimate: ~4 chars per token plus per-message overhead. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const PER_MESSAGE_OVERHEAD = 8;

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateTokens(m.content);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) total += estimateTokens(tc.argumentsJson) + 4;
    }
  }
  return total;
}

export type CompactionResult = {
  messages: ChatMessage[];
  droppedTurns: number;
  summaryTokens: number;
};

const KEEP_HEAD = 2; // system prompt + original task
const KEEP_TAIL = 8;
const SUMMARY_LINE_CHARS = 160;
const SUMMARY_MAX_CHARS = 4000;

/**
 * Phase 0 compaction: keep head (system + task) and the most recent tail,
 * replace the middle with a plain-text digest. Keeps assistant/tool pairing
 * intact by never starting the tail on a dangling role:"tool" message.
 * Returns null when the conversation already fits the budget.
 */
export function compactMessages(messages: ChatMessage[], budgetTokens: number): CompactionResult | null {
  if (estimateMessagesTokens(messages) <= budgetTokens) return null;
  if (messages.length <= KEEP_HEAD + KEEP_TAIL + 1) return null; // nothing meaningful to drop

  let tailStart = messages.length - KEEP_TAIL;
  // A tool message must stay with the assistant message that requested it.
  while (tailStart > KEEP_HEAD && messages[tailStart]?.role === "tool") tailStart--;
  if (tailStart <= KEEP_HEAD) return null;

  const dropped = messages.slice(KEEP_HEAD, tailStart);
  const lines: string[] = [];
  for (const m of dropped) {
    const text = m.content.replace(/\s+/g, " ").trim();
    const calls = m.toolCalls?.map((c) => c.name).join(",");
    lines.push(`- ${m.role}${calls ? ` [tools: ${calls}]` : ""}: ${text.slice(0, SUMMARY_LINE_CHARS)}`);
  }
  let digest = lines.join("\n");
  if (digest.length > SUMMARY_MAX_CHARS) {
    digest = `${digest.slice(0, SUMMARY_MAX_CHARS)}\n- …(further entries omitted)`;
  }

  const summaryMessage: ChatMessage = {
    role: "user",
    content:
      "[Context compacted to fit the window. Digest of the dropped earlier turns — " +
      "treat as background, re-read files if you need their exact content:]\n" +
      digest,
  };

  return {
    messages: [...messages.slice(0, KEEP_HEAD), summaryMessage, ...messages.slice(tailStart)],
    droppedTurns: dropped.length,
    summaryTokens: estimateTokens(summaryMessage.content),
  };
}

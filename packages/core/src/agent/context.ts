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

/** Tool outputs at or below this length are never micro-cleared. */
const CLEAR_MIN_CHARS = 200;
const CLEARED_TOOL_CONTENT = '{"ok":true,"note":"[old tool output cleared to save context]"}';
const DEFAULT_KEEP_LAST_TURNS = 2;

/**
 * Micro-compaction: blanks role:"tool" message contents OLDER than the last
 * `keepLastTurns` (default 2) user turns when they exceed 200 chars, replacing
 * them with a short JSON note. Cheaper than full compaction — assistant
 * reasoning and message structure stay intact, only stale tool payloads go.
 * Pure: returns a new array (input untouched) and the number of cleared
 * results. Idempotent — the replacement note is below the length threshold.
 */
export function clearOldToolResults(
  messages: ChatMessage[],
  keepLastTurns = DEFAULT_KEEP_LAST_TURNS,
): { messages: ChatMessage[]; cleared: number } {
  // Boundary: index of the keepLastTurns-th user message from the end. Tool
  // messages BEFORE it are "old". Fewer user turns than that = nothing is old.
  let boundary = -1;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== "user") continue;
    seen++;
    if (seen === keepLastTurns) {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return { messages, cleared: 0 };

  let cleared = 0;
  const out = messages.map((m, i) => {
    if (i >= boundary || m.role !== "tool" || m.content.length <= CLEAR_MIN_CHARS) return m;
    cleared++;
    return { ...m, content: CLEARED_TOOL_CONTENT };
  });
  return cleared > 0 ? { messages: out, cleared } : { messages, cleared: 0 };
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

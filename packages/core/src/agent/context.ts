import type { ChatMessage } from "@seekforge/shared";
import { loadSessionMessages, rewriteSessionMessages } from "./trace.js";

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
 * Shared head/tail boundary math for both compaction flavors: decides which
 * middle segment gets dropped. Keeps assistant/tool pairing intact by never
 * starting the kept tail on a dangling role:"tool" message. Returns null
 * when the conversation already fits the budget or is too short to compact.
 */
function splitForCompaction(
  messages: ChatMessage[],
  budgetTokens: number,
): { dropped: ChatMessage[]; tailStart: number } | null {
  if (estimateMessagesTokens(messages) <= budgetTokens) return null;
  if (messages.length <= KEEP_HEAD + KEEP_TAIL + 1) return null; // nothing meaningful to drop

  let tailStart = messages.length - KEEP_TAIL;
  // A tool message must stay with the assistant message that requested it.
  while (tailStart > KEEP_HEAD && messages[tailStart]?.role === "tool") tailStart--;
  if (tailStart <= KEEP_HEAD) return null;
  return { dropped: messages.slice(KEEP_HEAD, tailStart), tailStart };
}

/**
 * Wraps a compaction body (mechanical digest or LLM summary) in the SAME
 * framing message, so downstream consumers cannot tell the flavors apart.
 */
function compactionSummaryMessage(label: "Digest" | "Summary", body: string): ChatMessage {
  return {
    role: "user",
    content:
      `[Context compacted to fit the window. ${label} of the dropped earlier turns — ` +
      "treat as background, re-read files if you need their exact content:]\n" +
      body,
  };
}

/** Assembles head + summary + tail into a CompactionResult. */
function assembleCompaction(
  messages: ChatMessage[],
  tailStart: number,
  summaryMessage: ChatMessage,
  droppedTurns: number,
): CompactionResult {
  return {
    messages: [...messages.slice(0, KEEP_HEAD), summaryMessage, ...messages.slice(tailStart)],
    droppedTurns,
    summaryTokens: estimateTokens(summaryMessage.content),
  };
}

/**
 * Phase 0 compaction: keep head (system + task) and the most recent tail,
 * replace the middle with a plain-text digest. Keeps assistant/tool pairing
 * intact by never starting the tail on a dangling role:"tool" message.
 * Returns null when the conversation already fits the budget.
 */
export function compactMessages(messages: ChatMessage[], budgetTokens: number): CompactionResult | null {
  const split = splitForCompaction(messages, budgetTokens);
  if (!split) return null;

  const { dropped, tailStart } = split;
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

  return assembleCompaction(messages, tailStart, compactionSummaryMessage("Digest", digest), dropped.length);
}

/** Per-message cap for tool outputs in the segment sent to the summarizer. */
const LLM_TOOL_RESULT_PREVIEW_CHARS = 200;
/** Total cap for the serialized segment (≈6K tokens of summarizer input). */
const LLM_SEGMENT_CAP_CHARS = 24_000;
const LLM_SUMMARY_INSTRUCTION =
  "Summarize this conversation segment for an AI coding agent resuming work. Preserve, densely: " +
  "what still needs doing (remaining steps); decisions made and WHY; files/symbols touched with " +
  "exact paths; commands run + their outcomes; constraints/gotchas discovered; and any failed " +
  "approaches (so they are not retried). Keep concrete identifiers (paths, line refs, command " +
  "names) verbatim. Be dense, ≤500 words.";

/** Minimal provider surface needed for summarization (ChatProvider satisfies it). */
export type SummaryProvider = {
  chat(req: { messages: ChatMessage[] }): Promise<{ content: string }>;
};

/** Role-prefixed, size-capped plain-text rendering of the dropped segment. */
function serializeSegment(dropped: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of dropped) {
    const text =
      m.role === "tool" && m.content.length > LLM_TOOL_RESULT_PREVIEW_CHARS
        ? `${m.content.slice(0, LLM_TOOL_RESULT_PREVIEW_CHARS)}…`
        : m.content;
    const calls = m.toolCalls?.map((c) => c.name).join(",");
    lines.push(`${m.role}${calls ? ` [tools: ${calls}]` : ""}: ${text}`);
  }
  let out = lines.join("\n");
  if (out.length > LLM_SEGMENT_CAP_CHARS) {
    out = `${out.slice(0, LLM_SEGMENT_CAP_CHARS)}\n…(segment truncated)`;
  }
  return out;
}

/**
 * LLM-flavored compaction: same head/tail framing as compactMessages (shared
 * splitForCompaction boundary math), but the dropped middle is replaced by
 * ONE dense summary produced by a model call instead of a mechanical digest.
 * The summary message mirrors the mechanical digest's wrapper, so downstream
 * handling (trace replay, /context, resume) is identical.
 *
 * Returns null exactly when compactMessages would (under budget / too short),
 * and ADDITIONALLY on any provider failure or an empty summary — the caller
 * is expected to fall back to the mechanical compactMessages in that case.
 *
 * Note: trace.ts compactSessionNow (the TUI's manual /compact) deliberately
 * stays mechanical — no provider is available at that layer, and a manual
 * command should be deterministic and instant.
 */
export async function llmCompactMessages(
  provider: SummaryProvider,
  messages: ChatMessage[],
  budgetTokens: number,
  opts?: { focus?: string },
): Promise<CompactionResult | null> {
  const split = splitForCompaction(messages, budgetTokens);
  if (!split) return null;

  const segment = serializeSegment(split.dropped);
  // A focus steers the summary toward what the user cares about (e.g.
  // "/compact the auth refactor"); appended to the standard instruction.
  const focus = opts?.focus?.trim();
  const instruction =
    focus !== undefined && focus !== ""
      ? `${LLM_SUMMARY_INSTRUCTION} Focus especially on: ${focus}.`
      : LLM_SUMMARY_INSTRUCTION;
  let summary: string;
  try {
    const res = await provider.chat({
      messages: [{ role: "user", content: `${instruction}\n\n${segment}` }],
    });
    summary = res.content.trim();
  } catch {
    return null; // provider error → caller falls back to mechanical compaction
  }
  if (summary === "") return null;

  return assembleCompaction(
    messages,
    split.tailStart,
    compactionSummaryMessage("Summary", summary),
    split.dropped.length,
  );
}

export type LlmCompactSessionResult = {
  droppedTurns: number;
  beforeTokens: number;
  afterTokens: number;
};

/**
 * Manual LLM-summarized /compact of a STORED session, with an optional focus.
 * The LLM-flavored counterpart to trace.ts compactSessionNow (which stays
 * mechanical/provider-free): loads the session's messages, summarizes the
 * dropped middle with the provider via llmCompactMessages (budget 0 forces
 * compaction whenever the shape allows it), and rewrites messages.jsonl via
 * trace's existing rewrite helper. The next resume replays the compacted
 * history. Returns null when the session is too short to compact, has no
 * messages file, or the provider produced no usable summary (the caller can
 * fall back to the mechanical compactSessionNow).
 *
 * Frontends (the TUI /compact <focus> command) can wire this later — a
 * follow-up; today only the auto-compact site in the loop passes a focus.
 */
export async function llmCompactSessionNow(
  workspace: string,
  sessionId: string,
  provider: SummaryProvider,
  focus?: string,
): Promise<LlmCompactSessionResult | null> {
  let messages: ChatMessage[];
  try {
    messages = loadSessionMessages(workspace, sessionId);
  } catch {
    return null;
  }
  const beforeTokens = estimateMessagesTokens(messages);
  // Budget 0 forces compaction whenever the message shape allows it; null on
  // a too-short session OR any provider failure/empty summary.
  const compacted = await llmCompactMessages(
    provider,
    messages,
    0,
    focus !== undefined ? { focus } : undefined,
  );
  if (!compacted) return null;

  rewriteSessionMessages(workspace, sessionId, compacted.messages);
  return {
    droppedTurns: compacted.droppedTurns,
    beforeTokens,
    afterTokens: estimateMessagesTokens(compacted.messages),
  };
}

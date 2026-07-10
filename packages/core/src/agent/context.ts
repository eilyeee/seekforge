import type { ChatMessage, ProviderToolCall } from "@seekforge/shared";
import { loadSessionMessages, rewriteSessionMessages } from "./trace.js";

/**
 * CJK ranges where one character roughly equals one token under most
 * subword tokenizers: CJK Unified Ideographs (incl. Extension A), Hiragana,
 * Katakana, and Hangul syllables. These cover the bulk of Chinese/Japanese/
 * Korean text; we deliberately keep the set small and readable rather than
 * exhaustive (e.g. rare extension planes aren't worth the bloat). All four
 * ranges are BMP, so a charCodeAt test is exact — surrogate halves
 * (0xD800–0xDFFF) fall outside every range, so astral characters simply
 * count as non-CJK, same as under the previous regex.
 */
function isCjkCharCode(c: number): boolean {
  return (
    (c >= 0x3040 && c <= 0x30ff) || // Hiragana + Katakana
    (c >= 0x3400 && c <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
    (c >= 0xac00 && c <= 0xd7af) // Hangul syllables
  );
}

/**
 * Estimate token count — an HONEST heuristic, NOT a real tokenizer. DeepSeek's
 * actual tokenizer isn't reliably available in JS, and a wrong one is worse
 * than a transparent guess, so we keep this dependency-free.
 *
 * The plain `length / 4` rule under-counts CJK by ~4x (Chinese/Japanese/Korean
 * characters cost ~1 token each, not 0.25). So we count CJK characters as ~1
 * token apiece and the remaining (mostly-ASCII / code) characters at the old
 * ~4-chars-per-token rate: `cjkCount + ceil(nonCjkLen / 4)`.
 *
 * Counted with a code-unit loop rather than `.match()` — match() allocates an
 * array of every CJK character it finds, which on large histories is pure
 * garbage-collector pressure for a number we only ever count.
 *
 * Pure and monotonic: every extra character adds either 1 (CJK) or ≥0 to the
 * non-CJK bucket, so more text never lowers the estimate.
 */
export function estimateTokens(text: string): number {
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCharCode(text.charCodeAt(i))) cjkCount++;
  }
  const nonCjkLength = text.length - cjkCount;
  return cjkCount + Math.ceil(nonCjkLength / 4);
}

const PER_MESSAGE_OVERHEAD = 8;

/**
 * Per-message estimate cache. The loop calls estimateMessagesTokens on the
 * FULL history several times per turn (budget check, post-compaction check,
 * usage snapshot), so without this every turn re-scans megabytes of stable
 * text. Keyed on the message OBJECT: safe because ChatMessage instances are
 * treated as immutable everywhere in core — every content rewrite
 * (clearOldToolResults, shrinkToolResultsToFit, the loop's system-prompt
 * refresh) REPLACES the object via spread rather than mutating it, so a stale
 * entry cannot exist, and a WeakMap lets dropped histories collect naturally.
 */
const messageTokensCache = new WeakMap<ChatMessage, number>();

function estimateMessageTokens(m: ChatMessage): number {
  const cached = messageTokensCache.get(m);
  if (cached !== undefined) return cached;
  let total = PER_MESSAGE_OVERHEAD + estimateTokens(m.content);
  if (m.toolCalls) {
    for (const tc of m.toolCalls) total += estimateTokens(tc.argumentsJson) + 4;
  }
  messageTokensCache.set(m, total);
  return total;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/** Tool outputs at or below this length are never micro-cleared. */
const CLEAR_MIN_CHARS = 200;
const CLEARED_TOOL_CONTENT = '{"ok":true,"note":"[old tool output cleared to save context]"}';
const DEFAULT_KEEP_LAST_TURNS = 2;

/**
 * Arg keys, in priority order, that identify WHAT a tool call acted on — used
 * to enrich the cleared-tool note so the agent knows what to re-fetch. Covers
 * the built-in tools: path (read_file/write_file/list_files/glob/apply_patch/
 * search_text), pattern (search_text/glob), command (run_command), query
 * (web_search), url (web_fetch).
 */
const SOURCE_ARG_KEYS = ["path", "pattern", "command", "query", "url"] as const;

/** Short, safe label for a JSON arg value: stringified, trimmed, capped. */
function describeArgValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/**
 * Builds the source-aware cleared note for a tool message when it can be mapped
 * back to its originating tool call (by toolCallId). Falls back to the generic
 * note when there is no linkage or no usable arg. Stays well under
 * CLEAR_MIN_CHARS so re-running the clear never re-clears (idempotency).
 */
function clearedNoteFor(toolCallId: string | undefined, callsById: Map<string, ProviderToolCall>): string {
  if (toolCallId === undefined) return CLEARED_TOOL_CONTENT;
  const call = callsById.get(toolCallId);
  if (!call) return CLEARED_TOOL_CONTENT;

  let arg: string | undefined;
  try {
    const parsed: unknown = JSON.parse(call.argumentsJson);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of SOURCE_ARG_KEYS) {
        const described = describeArgValue(record[key]);
        if (described !== undefined) {
          arg = described;
          break;
        }
      }
    }
  } catch {
    // Unparseable args → fall through to the name-only note below.
  }

  const note =
    arg !== undefined
      ? `[old ${call.name} output for ${arg} cleared — re-run if you need it]`
      : `[old ${call.name} output cleared — re-run if you need it]`;
  // Keep the JSON-note shape consistent with the generic note.
  return JSON.stringify({ ok: true, note });
}

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

  // Map every tool call id to its originating assistant call, so a cleared
  // tool result can name the tool + key arg it answered (re-fetch hint).
  const callsById = new Map<string, ProviderToolCall>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const tc of m.toolCalls) callsById.set(tc.id, tc);
  }

  let cleared = 0;
  const out = messages.map((m, i) => {
    if (i >= boundary || m.role !== "tool" || m.content.length <= CLEAR_MIN_CHARS) return m;
    cleared++;
    return { ...m, content: clearedNoteFor(m.toolCallId, callsById) };
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

/** A tool result at or below this length isn't worth shrinking further. */
const TOOL_SHRINK_FLOOR_CHARS = 400;
const TOOL_SHRINK_MARKER = "\n…[tool output truncated to fit context]…\n";

/**
 * Last-resort compaction for the case splitForCompaction cannot handle: the
 * ENTIRE history is one assistant turn plus its tool results (a first turn with
 * many parallel tool calls), so nothing can be DROPPED without orphaning a tool
 * call — yet the tool payloads alone exceed budget, and compactMessages returns
 * null. Rather than send an over-budget request to the provider (which fails
 * with "context too long"), shrink the largest tool-result CONTENTS in place —
 * head+tail with a marker, largest first — until the estimate fits or nothing
 * is left to shrink. Never drops a message or touches a non-tool role, so the
 * assistant/tool pairing and message count are preserved. Returns null when the
 * conversation already fits or nothing can be shrunk (caller then proceeds).
 */
export function shrinkToolResultsToFit(messages: ChatMessage[], budgetTokens: number): CompactionResult | null {
  // Running total instead of re-estimating the whole history per iteration:
  // only the shrunk message's content term changes, so the total is adjusted
  // by exactly that delta (per-message estimates are independent sums).
  let total = estimateMessagesTokens(messages);
  if (total <= budgetTokens) return null;
  const out = messages.map((m) => ({ ...m }));
  // Largest tool results first — shrinking the biggest recovers the most.
  const toolOrder = out
    .map((m, i) => ({ i, len: m.content.length, isTool: m.role === "tool" }))
    .filter((x) => x.isTool)
    .sort((a, b) => b.len - a.len);
  const half = Math.floor(TOOL_SHRINK_FLOOR_CHARS / 2);
  // Shrinking rewrites content to `2*half + marker` chars; skip anything at or
  // below that size, or the "shrink" would grow it (and falsely report success).
  const minShrinkable = 2 * half + TOOL_SHRINK_MARKER.length;
  let shrunk = 0;
  for (const { i } of toolOrder) {
    if (total <= budgetTokens) break;
    const content = out[i]!.content;
    if (content.length <= minShrinkable) continue;
    const shrunkContent = content.slice(0, half) + TOOL_SHRINK_MARKER + content.slice(-half);
    out[i] = { ...out[i]!, content: shrunkContent };
    total += estimateTokens(shrunkContent) - estimateTokens(content);
    shrunk++;
  }
  if (shrunk === 0) return null;
  return { messages: out, droppedTurns: 0, summaryTokens: 0 };
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

/**
 * Pure SSE parsing + delta accumulation for DeepSeek streaming responses.
 * No I/O — feed it decoded text chunks (arbitrarily split) and finalize.
 */

import type { ChatFinishReason, ProviderToolCall } from "@seekforge/shared";
import { mapFinishReason, type WireUsage } from "./mapping.js";

type WireStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
};

export type SseAccumulator = {
  /** Carry-over for a partial line split across network chunks. */
  buffer: string;
  content: string;
  /** Accumulated chain-of-thought (V4 thinking mode). */
  reasoningContent: string;
  toolCallsByIndex: Map<number, { id: string; name: string; argumentsJson: string }>;
  rawFinishReason: string | null;
  usage: WireUsage | null;
  done: boolean;
};

export function createSseAccumulator(): SseAccumulator {
  return {
    buffer: "",
    content: "",
    reasoningContent: "",
    toolCallsByIndex: new Map(),
    rawFinishReason: null,
    usage: null,
    done: false,
  };
}

/**
 * Feed a decoded text chunk. Chunks may split SSE lines anywhere; complete
 * lines are processed, the remainder is buffered. Calls onDelta for each
 * content delta.
 */
export function feedSseChunk(
  acc: SseAccumulator,
  chunk: string,
  onDelta?: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): void {
  acc.buffer += chunk;
  let newlineIdx: number;
  while ((newlineIdx = acc.buffer.indexOf("\n")) !== -1) {
    const line = acc.buffer.slice(0, newlineIdx);
    acc.buffer = acc.buffer.slice(newlineIdx + 1);
    processLine(acc, line, onDelta, onReasoningDelta);
  }
}

function processLine(
  acc: SseAccumulator,
  rawLine: string,
  onDelta?: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): void {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith("data:")) return; // blank lines, comments, other fields
  const payload = line.slice("data:".length).trim();
  if (payload === "" ) return;
  if (payload === "[DONE]") {
    acc.done = true;
    return;
  }
  let parsed: WireStreamChunk;
  try {
    parsed = JSON.parse(payload) as WireStreamChunk;
  } catch {
    return; // tolerate garbage lines
  }
  if (parsed.usage) acc.usage = parsed.usage;
  const choice = parsed.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason != null) acc.rawFinishReason = choice.finish_reason;
  const delta = choice.delta;
  if (!delta) return;
  if (typeof delta.content === "string" && delta.content.length > 0) {
    acc.content += delta.content;
    onDelta?.(delta.content);
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    acc.reasoningContent += delta.reasoning_content;
    onReasoningDelta?.(delta.reasoning_content);
  }
  for (const tc of delta.tool_calls ?? []) {
    const index = tc.index ?? 0;
    let entry = acc.toolCallsByIndex.get(index);
    if (!entry) {
      entry = { id: "", name: "", argumentsJson: "" };
      acc.toolCallsByIndex.set(index, entry);
    }
    if (tc.id) entry.id = tc.id;
    if (tc.function?.name) entry.name += tc.function.name;
    if (tc.function?.arguments) entry.argumentsJson += tc.function.arguments;
  }
}

export type SseResult = {
  content: string;
  reasoningContent: string;
  toolCalls: ProviderToolCall[];
  finishReason: ChatFinishReason;
  usage: WireUsage | null;
};

export function finalizeSse(acc: SseAccumulator): SseResult {
  // Flush a trailing line that arrived without a final newline.
  if (acc.buffer.length > 0) {
    const rest = acc.buffer;
    acc.buffer = "";
    processLine(acc, rest);
  }
  const toolCalls = [...acc.toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, entry]) => ({
      id: entry.id || `call-${index + 1}`,
      name: entry.name,
      argumentsJson: entry.argumentsJson,
    }));
  return {
    content: acc.content,
    reasoningContent: acc.reasoningContent,
    toolCalls,
    finishReason: mapFinishReason(acc.rawFinishReason),
    usage: acc.usage,
  };
}

/**
 * Pure SSE parsing + delta accumulation for DeepSeek streaming responses.
 * No I/O — feed it decoded text chunks (arbitrarily split) and finalize.
 */

import type { ChatFinishReason, ProviderToolCall } from "@seekforge/shared";
import { mapFinishReason, type WireUsage } from "./mapping.js";

/** Maximum decoded characters accepted for one SSE line, including fragments. */
export const MAX_SSE_LINE_CHARS = 1024 * 1024;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  let offset = 0;
  while (offset < chunk.length) {
    const newlineIdx = chunk.indexOf("\n", offset);
    const end = newlineIdx === -1 ? chunk.length : newlineIdx;
    const fragmentLength = end - offset;
    if (acc.buffer.length + fragmentLength > MAX_SSE_LINE_CHARS) {
      throw new Error(`SSE line exceeds ${MAX_SSE_LINE_CHARS} characters`);
    }
    acc.buffer += chunk.slice(offset, end);
    if (newlineIdx === -1) return;

    const line = acc.buffer;
    acc.buffer = "";
    processLine(acc, line, onDelta, onReasoningDelta);
    offset = newlineIdx + 1;
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
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return; // tolerate garbage lines
  }
  if (!isRecord(value)) return;
  if (isRecord(value["usage"])) acc.usage = value["usage"] as WireUsage;
  const choices = value["choices"];
  const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
  if (!choice) return;
  if (typeof choice["finish_reason"] === "string") acc.rawFinishReason = choice["finish_reason"];
  const delta = isRecord(choice["delta"]) ? choice["delta"] : undefined;
  if (!delta) return;
  if (typeof delta["content"] === "string" && delta["content"].length > 0) {
    acc.content += delta["content"];
    onDelta?.(delta["content"]);
  }
  if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"].length > 0) {
    acc.reasoningContent += delta["reasoning_content"];
    onReasoningDelta?.(delta["reasoning_content"]);
  }
  const toolCalls = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
  for (const tc of toolCalls) {
    if (!isRecord(tc)) continue;
    const index = Number.isSafeInteger(tc["index"]) && (tc["index"] as number) >= 0
      ? tc["index"] as number
      : 0;
    let entry = acc.toolCallsByIndex.get(index);
    if (!entry) {
      entry = { id: "", name: "", argumentsJson: "" };
      acc.toolCallsByIndex.set(index, entry);
    }
    if (typeof tc["id"] === "string" && tc["id"]) entry.id = tc["id"];
    const fn = isRecord(tc["function"]) ? tc["function"] : undefined;
    if (typeof fn?.["name"] === "string" && fn["name"]) entry.name = fn["name"];
    if (typeof fn?.["arguments"] === "string" && fn["arguments"]) entry.argumentsJson += fn["arguments"];
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

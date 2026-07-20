/**
 * Pure SSE parsing + delta accumulation for DeepSeek streaming responses.
 * No I/O — feed it decoded text chunks (arbitrarily split) and finalize.
 */

import type { ChatFinishReason, ProviderToolCall } from "@seekforge/shared";
import { mapFinishReason, ProviderProtocolError, type WireUsage } from "./mapping.js";
import { isRecord } from "../util/guards.js";
import {
  MAX_SSE_CONTENT_CHARS,
  MAX_SSE_DECODED_CHARS,
  MAX_SSE_LINE_CHARS,
  MAX_SSE_REASONING_CHARS,
  MAX_SSE_TOOL_ARGUMENT_CHARS,
  MAX_SSE_TOOL_CALLS,
  MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
} from "./protocol-limits.js";

export {
  MAX_SSE_CONTENT_CHARS,
  MAX_SSE_DECODED_CHARS,
  MAX_SSE_LINE_CHARS,
  MAX_SSE_REASONING_CHARS,
  MAX_SSE_TOOL_ARGUMENT_CHARS,
  MAX_SSE_TOOL_CALLS,
  MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
} from "./protocol-limits.js";

export type SseLimits = {
  decodedChars: number;
  contentChars: number;
  reasoningChars: number;
  toolArgumentChars: number;
  totalToolArgumentChars: number;
  toolCalls: number;
};

const DEFAULT_SSE_LIMITS: SseLimits = {
  decodedChars: MAX_SSE_DECODED_CHARS,
  contentChars: MAX_SSE_CONTENT_CHARS,
  reasoningChars: MAX_SSE_REASONING_CHARS,
  toolArgumentChars: MAX_SSE_TOOL_ARGUMENT_CHARS,
  totalToolArgumentChars: MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
  toolCalls: MAX_SSE_TOOL_CALLS,
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
  decodedChars: number;
  totalToolArgumentChars: number;
  limits: SseLimits;
};

export function createSseAccumulator(limits: Partial<SseLimits> = {}): SseAccumulator {
  return {
    buffer: "",
    content: "",
    reasoningContent: "",
    toolCallsByIndex: new Map(),
    rawFinishReason: null,
    usage: null,
    done: false,
    decodedChars: 0,
    totalToolArgumentChars: 0,
    limits: { ...DEFAULT_SSE_LIMITS, ...limits },
  };
}

function protocolLimit(label: string, limit: number): ProviderProtocolError {
  return new ProviderProtocolError(`Provider protocol error: SSE ${label} exceeds ${limit}`);
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
  if (chunk.length > acc.limits.decodedChars - acc.decodedChars) {
    throw protocolLimit("decoded content", acc.limits.decodedChars);
  }
  acc.decodedChars += chunk.length;
  let offset = 0;
  while (offset < chunk.length) {
    const newlineIdx = chunk.indexOf("\n", offset);
    const end = newlineIdx === -1 ? chunk.length : newlineIdx;
    const fragmentLength = end - offset;
    if (acc.buffer.length + fragmentLength > MAX_SSE_LINE_CHARS) {
      throw protocolLimit("line", MAX_SSE_LINE_CHARS);
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
  if (payload === "") return;
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
    if (delta["content"].length > acc.limits.contentChars - acc.content.length) {
      throw protocolLimit("content", acc.limits.contentChars);
    }
    acc.content += delta["content"];
    onDelta?.(delta["content"]);
  }
  if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"].length > 0) {
    if (delta["reasoning_content"].length > acc.limits.reasoningChars - acc.reasoningContent.length) {
      throw protocolLimit("reasoning content", acc.limits.reasoningChars);
    }
    acc.reasoningContent += delta["reasoning_content"];
    onReasoningDelta?.(delta["reasoning_content"]);
  }
  const toolCalls = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
  for (const tc of toolCalls) {
    if (!isRecord(tc)) continue;
    const index = Number.isSafeInteger(tc["index"]) && (tc["index"] as number) >= 0 ? (tc["index"] as number) : 0;
    let entry = acc.toolCallsByIndex.get(index);
    if (!entry) {
      if (acc.toolCallsByIndex.size >= acc.limits.toolCalls) {
        throw protocolLimit("tool call count", acc.limits.toolCalls);
      }
      entry = { id: "", name: "", argumentsJson: "" };
      acc.toolCallsByIndex.set(index, entry);
    }
    if (typeof tc["id"] === "string" && tc["id"]) entry.id = tc["id"];
    const fn = isRecord(tc["function"]) ? tc["function"] : undefined;
    if (typeof fn?.["name"] === "string" && fn["name"]) entry.name = fn["name"];
    if (typeof fn?.["arguments"] === "string" && fn["arguments"]) {
      const argumentDelta = fn["arguments"];
      if (argumentDelta.length > acc.limits.toolArgumentChars - entry.argumentsJson.length) {
        throw protocolLimit("tool arguments", acc.limits.toolArgumentChars);
      }
      if (argumentDelta.length > acc.limits.totalToolArgumentChars - acc.totalToolArgumentChars) {
        throw protocolLimit("total tool arguments", acc.limits.totalToolArgumentChars);
      }
      entry.argumentsJson += argumentDelta;
      acc.totalToolArgumentChars += argumentDelta.length;
    }
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

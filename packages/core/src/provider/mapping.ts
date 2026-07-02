/**
 * Pure mapping between SeekForge types (@seekforge/shared) and the
 * OpenAI-compatible DeepSeek wire format. No I/O here — unit-testable.
 */

import type {
  ChatFinishReason,
  ChatMessage,
  ChatResponse,
  ProviderToolCall,
  TokenUsage,
  ToolDefinitionForModel,
} from "@seekforge/shared";
import { estimateCostUsd } from "./cost.js";
import type { ChatRequest } from "./types.js";

// --- wire types (only the fields we read/write) -----------------------------

export type WireToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type WireMessage = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type WireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

export type WireChatCompletion = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
};

/** Request-side thinking controls (DeepSeek V4 only). */
export type ThinkingOptions = {
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
};

/** thinking.{type,reasoning_effort} is only valid on deepseek-v4-* models. */
export function supportsThinking(model: string): boolean {
  return model.startsWith("deepseek-v4");
}

// --- request mapping --------------------------------------------------------

export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  // Enforce the tool-call pairing the OpenAI-compatible API requires: every
  // assistant tool_call must have a matching tool response, and every tool
  // message must answer a known tool_call. A history persisted mid-turn — a run
  // cancelled or errored between the assistant message and its tool results, or
  // hitting the tool-call cap (see agent/loop.ts) — violates this, and replaying
  // it verbatim 400s the request on /resume. Drop unanswered assistant
  // tool_calls and orphan tool results so the request is always well-formed;
  // for a well-paired live history this is a no-op.
  const respondedIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId !== undefined) respondedIds.add(m.toolCallId);
  }
  const keptCallIds = new Set<string>();
  const out: WireMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      // Orphan tool result: no preceding (kept) assistant tool_call — drop it.
      if (m.toolCallId === undefined || !keptCallIds.has(m.toolCallId)) continue;
      out.push({ role: m.role, content: m.content, tool_call_id: m.toolCallId });
      continue;
    }
    const wire: WireMessage = { role: m.role, content: m.content };
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const kept = m.toolCalls.filter((c) => respondedIds.has(c.id));
      if (kept.length > 0) {
        wire.tool_calls = kept.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsJson },
        }));
        for (const c of kept) keptCallIds.add(c.id);
      }
    }
    out.push(wire);
  }
  return out;
}

export function toWireTools(
  tools: ToolDefinitionForModel[],
): Array<{ type: "function"; function: ToolDefinitionForModel }> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function buildRequestBody(
  model: string,
  req: ChatRequest,
  stream: boolean,
  thinking?: ThinkingOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: toWireMessages(req.messages),
    stream,
  };
  if (req.tools && req.tools.length > 0) body.tools = toWireTools(req.tools);
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (stream) body.stream_options = { include_usage: true };
  // V4 thinking mode. Note: reasoning_content from responses is never echoed
  // back (toWireMessages builds from our ChatMessage, which has no such
  // field) — the API 400s on requests containing it.
  if (supportsThinking(model) && (thinking?.thinking !== undefined || thinking?.reasoningEffort)) {
    body.thinking = {
      type: thinking.thinking === false ? "disabled" : "enabled",
      ...(thinking.reasoningEffort ? { reasoning_effort: thinking.reasoningEffort } : {}),
    };
  }
  return body;
}

// --- response mapping -------------------------------------------------------

export function mapFinishReason(raw: string | null | undefined): ChatFinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    default:
      return "other";
  }
}

export function mapUsage(raw: WireUsage | null | undefined, model: string): TokenUsage {
  const tokens = {
    promptTokens: raw?.prompt_tokens ?? 0,
    completionTokens: raw?.completion_tokens ?? 0,
    cacheHitTokens: raw?.prompt_cache_hit_tokens ?? 0,
  };
  return { ...tokens, costUsd: estimateCostUsd(tokens, model) };
}

export function mapWireToolCalls(raw: WireToolCall[] | undefined): ProviderToolCall[] {
  return (raw ?? []).map((c, i) => ({
    id: c.id ?? `call-${i + 1}`,
    name: c.function?.name ?? "",
    argumentsJson: c.function?.arguments ?? "",
  }));
}

export function mapChatResponse(json: WireChatCompletion, model: string): ChatResponse {
  const choice = json.choices?.[0];
  const reasoning = choice?.message?.reasoning_content;
  return {
    content: choice?.message?.content ?? "",
    toolCalls: mapWireToolCalls(choice?.message?.tool_calls),
    finishReason: mapFinishReason(choice?.finish_reason),
    usage: mapUsage(json.usage, model),
    ...(typeof reasoning === "string" && reasoning.length > 0 ? { reasoningContent: reasoning } : {}),
  };
}

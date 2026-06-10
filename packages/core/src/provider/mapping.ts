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
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
};

// --- request mapping --------------------------------------------------------

export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    const wire: WireMessage = { role: m.role, content: m.content };
    if (m.role === "tool" && m.toolCallId !== undefined) {
      wire.tool_call_id = m.toolCallId;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.argumentsJson },
      }));
    }
    return wire;
  });
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
  return {
    content: choice?.message?.content ?? "",
    toolCalls: mapWireToolCalls(choice?.message?.tool_calls),
    finishReason: mapFinishReason(choice?.finish_reason),
    usage: mapUsage(json.usage, model),
  };
}

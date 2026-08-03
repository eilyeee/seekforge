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
import type { ModelPricing } from "./constants.js";
import { estimateCostUsd } from "./cost.js";
import type { ChatRequest, ProviderCapabilities } from "./types.js";
import { isRecord } from "../util/guards.js";
import { withPairedToolCalls } from "./tool-pairing.js";
import {
  MAX_SSE_CONTENT_CHARS,
  MAX_SSE_REASONING_CHARS,
  MAX_SSE_TOOL_ARGUMENT_CHARS,
  MAX_SSE_TOOL_CALLS,
  MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
} from "./protocol-limits.js";

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
  /** OpenAI-compatible spelling of the cache-hit count (`prompt_cache_hit_tokens` on DeepSeek). */
  prompt_tokens_details?: { cached_tokens?: number };
};

export type WireChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      /** OpenAI-compatible spelling of `reasoning_content`. */
      reasoning?: string | null;
      tool_calls?: WireToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
};

/** Request-side thinking controls (DeepSeek V4 only). */
export type ThinkingOptions = {
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
};

export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

/** Generous protocol ceiling that still keeps arithmetic and persisted usage bounded. */
export const MAX_PROVIDER_USAGE_TOKENS = 1_000_000_000;

/** thinking.{type,reasoning_effort} is only valid on deepseek-v4-* models. */
export function supportsThinking(model: string): boolean {
  return model.startsWith("deepseek-v4");
}

// --- request mapping --------------------------------------------------------

export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  // Unanswered tool calls and orphan results are dropped first (see
  // tool-pairing.ts) — the OpenAI-compatible API rejects either.
  return withPairedToolCalls(messages).flatMap((m) => {
    if (m.role === "tool") {
      return m.toolCallId === undefined ? [] : [{ role: m.role, content: m.content, tool_call_id: m.toolCallId }];
    }
    const wire: WireMessage = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.argumentsJson },
      }));
    }
    return [wire];
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
  thinking?: ThinkingOptions,
  capabilities?: ProviderCapabilities,
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
  if (
    (capabilities?.thinking ?? true) &&
    supportsThinking(model) &&
    (thinking?.thinking !== undefined || thinking?.reasoningEffort)
  ) {
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
    // Legacy OpenAI spelling, still emitted by some OpenAI-compatible
    // endpoints. Treating it as "other" would end the turn with unexecuted
    // tool calls, so it maps to the same outcome as tool_calls.
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    default:
      return "other";
  }
}

/**
 * A token count is only usable if it is a plain non-negative integer within a
 * sane ceiling: it is persisted, summed into budgets and multiplied by a price,
 * so a float, a negative, or 1e300 from a misbehaving endpoint would corrupt
 * every number derived from it. Shared by every wire protocol's usage mapping.
 */
export function validUsageCount(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PROVIDER_USAGE_TOKENS) {
    throw new ProviderProtocolError(
      `Provider protocol error: usage.${field} must be a non-negative safe integer no greater than ${MAX_PROVIDER_USAGE_TOKENS}`,
    );
  }
  return value;
}

/**
 * Attach a cost to already-counted tokens.
 *
 * A user-supplied price for this model always wins — it enables cost/budget
 * tracking on providers whose preset sets costAccounting: false (Ark, OpenAI).
 * Otherwise keep the built-in behavior: priced when costAccounting, else 0.
 * Protocol-independent, so every wire mapping reports cost the same way.
 */
export function priceUsage(
  tokens: Pick<TokenUsage, "promptTokens" | "completionTokens" | "cacheHitTokens">,
  model: string,
  capabilities?: ProviderCapabilities,
  modelPricing?: Record<string, ModelPricing>,
): TokenUsage {
  const costUsd =
    modelPricing?.[model] !== undefined
      ? estimateCostUsd(tokens, model, modelPricing)
      : (capabilities?.costAccounting ?? true)
        ? estimateCostUsd(tokens, model)
        : 0;
  return { ...tokens, costUsd };
}

export function mapUsage(
  raw: WireUsage | null | undefined,
  model: string,
  capabilities?: ProviderCapabilities,
  modelPricing?: Record<string, ModelPricing>,
): TokenUsage {
  const tokenCount = (field: Exclude<keyof WireUsage, "prompt_tokens_details">): number =>
    validUsageCount(raw?.[field], field);
  // Validate every token field the wire protocol can report, including the
  // miss count that cost accounting derives from prompt minus cache-hit tokens.
  tokenCount("prompt_cache_miss_tokens");
  const detailsCached = validUsageCount(
    raw?.prompt_tokens_details?.cached_tokens,
    "prompt_tokens_details.cached_tokens",
  );
  // OpenAI-compatible endpoints report cache hits under prompt_tokens_details;
  // DeepSeek's own field wins when both are present.
  const cacheHitTokens =
    raw?.prompt_cache_hit_tokens !== undefined ? tokenCount("prompt_cache_hit_tokens") : detailsCached;
  const tokens = {
    promptTokens: tokenCount("prompt_tokens"),
    completionTokens: tokenCount("completion_tokens"),
    cacheHitTokens: 0,
  };
  tokens.cacheHitTokens = (capabilities?.cacheHitTokens ?? true) ? Math.min(cacheHitTokens, tokens.promptTokens) : 0;
  return priceUsage(tokens, model, capabilities, modelPricing);
}

export function mapWireToolCalls(raw: WireToolCall[] | undefined): ProviderToolCall[] {
  const values = Array.isArray(raw) ? raw : [];
  if (values.length > MAX_SSE_TOOL_CALLS) {
    throw new ProviderProtocolError(`Provider protocol error: tool call count exceeds ${MAX_SSE_TOOL_CALLS}`);
  }
  let totalArgumentChars = 0;
  return values.flatMap((value, i) => {
    if (!isRecord(value)) return [];
    const fn = isRecord(value["function"]) ? value["function"] : undefined;
    const argumentsJson = typeof fn?.["arguments"] === "string" ? fn["arguments"] : "";
    if (argumentsJson.length > MAX_SSE_TOOL_ARGUMENT_CHARS) {
      throw new ProviderProtocolError(`Provider protocol error: tool arguments exceed ${MAX_SSE_TOOL_ARGUMENT_CHARS}`);
    }
    totalArgumentChars += argumentsJson.length;
    if (totalArgumentChars > MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS) {
      throw new ProviderProtocolError(
        `Provider protocol error: total tool arguments exceed ${MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS}`,
      );
    }
    return [
      {
        id: typeof value["id"] === "string" ? value["id"] : `call-${i + 1}`,
        name: typeof fn?.["name"] === "string" ? fn["name"] : "",
        argumentsJson,
      },
    ];
  });
}

export function mapChatResponse(
  json: unknown,
  model: string,
  capabilities?: ProviderCapabilities,
  modelPricing?: Record<string, ModelPricing>,
): ChatResponse {
  if (!isRecord(json)) {
    throw new ProviderProtocolError("Provider protocol error: response body must be an object");
  }
  const root = json;
  const error = root["error"];
  if (error !== undefined) {
    const message = isRecord(error) && typeof error["message"] === "string" ? `: ${error["message"]}` : "";
    throw new ProviderProtocolError(`Provider protocol error: successful response contained an error${message}`);
  }
  const choices = root["choices"];
  const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
  if (!choice) {
    throw new ProviderProtocolError("Provider protocol error: successful response has no choices");
  }
  const message = isRecord(choice?.["message"]) ? choice["message"] : undefined;
  if (!message) {
    throw new ProviderProtocolError("Provider protocol error: first choice has no message");
  }
  // DeepSeek spells it `reasoning_content`; OpenAI-compatible relays
  // (OpenRouter, Ark, vLLM) spell the same field `reasoning`.
  const reasoning =
    typeof message?.["reasoning_content"] === "string" ? message["reasoning_content"] : message?.["reasoning"];
  const content = typeof message?.["content"] === "string" ? message["content"] : "";
  if (content.length > MAX_SSE_CONTENT_CHARS) {
    throw new ProviderProtocolError(`Provider protocol error: content exceeds ${MAX_SSE_CONTENT_CHARS}`);
  }
  if (typeof reasoning === "string" && reasoning.length > MAX_SSE_REASONING_CHARS) {
    throw new ProviderProtocolError(`Provider protocol error: reasoning content exceeds ${MAX_SSE_REASONING_CHARS}`);
  }
  return {
    content,
    toolCalls: mapWireToolCalls(message?.["tool_calls"] as WireToolCall[] | undefined),
    finishReason: mapFinishReason(typeof choice?.["finish_reason"] === "string" ? choice["finish_reason"] : undefined),
    usage: mapUsage(
      isRecord(root["usage"]) ? (root["usage"] as WireUsage) : undefined,
      model,
      capabilities,
      modelPricing,
    ),
    ...(typeof reasoning === "string" && reasoning.length > 0 ? { reasoningContent: reasoning } : {}),
  };
}

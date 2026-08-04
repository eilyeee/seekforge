/**
 * The Anthropic Messages protocol (`POST {base}/messages`).
 *
 * A second wire protocol, not a second provider: retries, the fallback model,
 * timeouts, byte ceilings, cancellation and cost accounting all stay in the
 * shared provider. What differs here is genuinely different, and most of it is
 * shape rather than behavior:
 *
 *   - auth is `x-api-key` + `anthropic-version`, not a bearer token;
 *   - a turn is a list of typed content blocks, so a tool call is a `tool_use`
 *     block carrying a parsed object (not a JSON string in a side channel) and
 *     its result is a `tool_result` block inside the NEXT user turn;
 *   - the system prompt is a top-level field, not a message;
 *   - `max_tokens` is required;
 *   - sampling parameters were removed from the current model line, so none are
 *     ever sent;
 *   - streaming is a typed event log (`content_block_delta`, `message_delta`,
 *     `message_stop`) rather than repeated completion snapshots terminated by
 *     `[DONE]`;
 *   - usage reports the *uncached remainder* as `input_tokens`, with cache
 *     reads and writes counted separately.
 *
 * Everything the two protocols agree on — that a tool call must be answered,
 * what a token count may look like, how a cost is derived, how SSE lines are
 * framed — is imported, not restated.
 */

import type { ChatFinishReason, ChatMessage, ProviderToolCall, ToolDefinitionForModel } from "@seekforge/shared";
import type { ModelPricing } from "../constants.js";
import { isRecord } from "../../util/guards.js";
import { DeepSeekApiError } from "../http.js";
import { priceUsage, ProviderProtocolError, validUsageCount } from "../mapping.js";
import {
  MAX_SSE_CONTENT_CHARS,
  MAX_SSE_DECODED_CHARS,
  MAX_SSE_REASONING_CHARS,
  MAX_SSE_TOOL_ARGUMENT_CHARS,
  MAX_SSE_TOOL_CALLS,
  MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
} from "../protocol-limits.js";
import { createSseFrameState, feedSseFrames, flushSseFrames, parseSsePayload, protocolLimit } from "../sse-frame.js";
import type { SseFrameState } from "../sse-frame.js";
import { withPairedToolCalls } from "../tool-pairing.js";
import type { ProviderCapabilities } from "../types.js";
import type { WireProtocol, WireStreamSession } from "./types.js";

/** Pinned wire version; Anthropic requires it on every request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Prompt caching is opt-in per request on this protocol, and an agent loop is
 * exactly the shape it exists for: the same tools and system prompt are resent
 * on every turn, and the conversation only ever grows at the end. Without a
 * breakpoint none of that is cached and every turn re-pays full input price for
 * the whole prefix; with one, a hit bills at a tenth.
 *
 * Two breakpoints, both on the boundary of something that does not change:
 *
 *  1. the end of the system prompt, which covers `tools` + `system` — the
 *     largest genuinely fixed span, since the wire order is tools, system,
 *     messages;
 *  2. the end of the last message, so the next turn reads the whole
 *     conversation so far instead of reprocessing it.
 *
 * The second is what makes a long run cheap, and it is also why the ordering
 * rules in toAnthropicMessages matter more than they look: a prefix that
 * changes shape mid-conversation invalidates everything after it.
 *
 * The one thing that can defeat both: tools render FIRST, so a tool catalog
 * that changes between turns invalidates the system prompt and the whole
 * conversation with it. That happens only when
 * `selectToolDefinitionsForBudget` (agent/context.ts) narrows a catalog too
 * large for the window — rare, and the price of a wasted write is a quarter of
 * that prefix against the nine tenths a hit saves, so it is not worth trading
 * context correctness to avoid.
 */
const CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * Below this the tail breakpoint is not worth its write premium: a cache write
 * costs 1.25x and a read saves 0.9x, so a prefix that will be read at least
 * once pays for itself, but a conversation that is still one turn long may
 * never be resent at all.
 */
const MIN_MESSAGES_FOR_TAIL_CACHE = 3;

/**
 * `max_tokens` is required, so an absent per-request value still has to become
 * a number. 16k fits under every current Claude model's output ceiling and is
 * generous for one agentic turn. It bounds thinking *and* visible text
 * together, which is why it is not smaller; a caller that needs more sets
 * `maxTokens` on the request.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000;

// --- request mapping --------------------------------------------------------

type CacheControl = { cache_control?: { readonly type: "ephemeral" } };

type AnthropicContentBlock = CacheControl &
  (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string }
  );

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };

/**
 * A tool call's arguments travel as a parsed object here, not as the string the
 * model emitted. A historical call whose arguments never parsed cannot be
 * reconstructed; sending the raw string instead would fail validation and take
 * every later turn of the session down with it, so the one unreadable input
 * degrades to `{}` and the rest of the history survives.
 */
function parseToolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Fold a SeekForge history into `{ system, messages }`.
 *
 * Three rules the API enforces and a chat-completions history does not:
 * system prompts are hoisted out of the message list; tool results live in the
 * user turn that follows the calls they answer (all of them in ONE turn, so
 * parallel calls stay one exchange); and content is never empty.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const paired = withPairedToolCalls(messages);
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let pendingToolResults: AnthropicContentBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of paired) {
    if (m.role === "system") {
      flushToolResults();
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      if (m.toolCallId === undefined) continue;
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.toolCallId,
        // A tool that returned nothing still has to say so: an empty block is
        // rejected, and silently dropping the result orphans the call.
        content: m.content === "" ? "(no output)" : m.content,
      });
      continue;
    }
    flushToolResults();
    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parseToolInput(call.argumentsJson) });
      }
      // An assistant turn with neither text nor surviving tool calls is not
      // representable, and carries nothing the model needs.
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.content) out.push({ role: "user", content: m.content });
  }
  flushToolResults();

  // A trailing assistant turn is a prefill, which the current model line
  // rejects. It only ever appears when an interrupted turn's tool results were
  // dropped above, leaving the opening of a turn that never finished — asking
  // the model to continue writing it is not what the caller wanted anyway.
  while (out.length > 0 && out[out.length - 1]!.role === "assistant") out.pop();

  const system = systemParts.join("\n\n");
  return { ...(system ? { system } : {}), messages: out };
}

/**
 * Mark the end of the conversation as cacheable, so the next turn reads this
 * one's prefix instead of reprocessing it.
 *
 * The marker goes on the LAST content block of the LAST message: a cache is a
 * prefix match, so this is the furthest point that is still common to the next
 * request. A string-content message is expanded into a block to carry it —
 * `content` accepts either form, and only the block form has somewhere to put
 * the marker.
 */
function withTailCacheBreakpoint(messages: AnthropicMessage[]): AnthropicMessage[] {
  const last = messages[messages.length - 1];
  if (last === undefined || messages.length < MIN_MESSAGES_FOR_TAIL_CACHE) return messages;
  const blocks: AnthropicContentBlock[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1];
  if (tail === undefined) return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: CACHE_CONTROL };
  return [...messages.slice(0, -1), { role: last.role, content: blocks }];
}

export function toAnthropicTools(
  tools: ToolDefinitionForModel[],
): Array<{ name: string; description: string; input_schema: unknown }> {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

// --- response mapping -------------------------------------------------------

export function mapAnthropicStopReason(raw: string | null | undefined): ChatFinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      // Includes "refusal" (a safety classifier declined) and "pause_turn" (a
      // server-side tool loop paused). Neither is a completed answer.
      return "other";
  }
}

/**
 * A refusal arrives as a successful response with no content. Reporting that as
 * an empty assistant turn would look like the model had nothing to say, so the
 * reason is surfaced as the answer.
 */
export function refusalNotice(stopDetails: unknown): string {
  const explanation = isRecord(stopDetails) ? stopDetails["explanation"] : undefined;
  if (typeof explanation === "string" && explanation.length > 0) return explanation;
  const category = isRecord(stopDetails) ? stopDetails["category"] : undefined;
  return typeof category === "string" && category.length > 0
    ? `The provider declined this request (${category}).`
    : "The provider declined this request.";
}

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * `input_tokens` here is the UNCACHED remainder, not the prompt size: the whole
 * prompt is `input_tokens + cache_read + cache_creation`. Reporting the field
 * as-is would understate every prompt that hit the cache — and the cache is on
 * by default — so the three are summed back into one prompt count.
 *
 * Cache writes are billed above the ordinary input rate upstream; the built-in
 * price table has a hit rate and a miss rate and no slot for a write premium,
 * so a turn that populates the cache is priced slightly under its invoice.
 */
export function mapAnthropicUsage(
  raw: unknown,
  model: string,
  capabilities: ProviderCapabilities,
  modelPricing?: Record<string, ModelPricing>,
) {
  const usage: AnthropicUsage = isRecord(raw) ? (raw as AnthropicUsage) : {};
  const input = validUsageCount(usage.input_tokens, "input_tokens");
  const cacheRead = validUsageCount(usage.cache_read_input_tokens, "cache_read_input_tokens");
  const cacheWrite = validUsageCount(usage.cache_creation_input_tokens, "cache_creation_input_tokens");
  const promptTokens = input + cacheRead + cacheWrite;
  return priceUsage(
    {
      promptTokens,
      completionTokens: validUsageCount(usage.output_tokens, "output_tokens"),
      cacheHitTokens: capabilities.cacheHitTokens ? Math.min(cacheRead, promptTokens) : 0,
      // Reported separately because it is billed separately: populating the
      // cache costs more than an ordinary input token, and a cost nobody can
      // reconstruct from the counts next to it is the kind of number this
      // project does not ship.
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    },
    model,
    capabilities,
    modelPricing,
  );
}

/** Accumulates the content blocks of a response, whole or streamed, under the shared ceilings. */
type BlockCollector = {
  content: string;
  reasoningContent: string;
  toolBlocks: Map<number, { id: string; name: string; argumentsJson: string }>;
  totalToolArgumentChars: number;
};

function createBlockCollector(): BlockCollector {
  return { content: "", reasoningContent: "", toolBlocks: new Map(), totalToolArgumentChars: 0 };
}

function addText(collector: BlockCollector, text: string): void {
  if (text.length > MAX_SSE_CONTENT_CHARS - collector.content.length) {
    throw protocolLimit("content", MAX_SSE_CONTENT_CHARS);
  }
  collector.content += text;
}

function addThinking(collector: BlockCollector, text: string): void {
  if (text.length > MAX_SSE_REASONING_CHARS - collector.reasoningContent.length) {
    throw protocolLimit("reasoning content", MAX_SSE_REASONING_CHARS);
  }
  collector.reasoningContent += text;
}

function toolBlock(collector: BlockCollector, index: number): { id: string; name: string; argumentsJson: string } {
  let entry = collector.toolBlocks.get(index);
  if (!entry) {
    if (collector.toolBlocks.size >= MAX_SSE_TOOL_CALLS) {
      throw protocolLimit("tool call count", MAX_SSE_TOOL_CALLS);
    }
    entry = { id: "", name: "", argumentsJson: "" };
    collector.toolBlocks.set(index, entry);
  }
  return entry;
}

function addToolArguments(collector: BlockCollector, index: number, json: string): void {
  const entry = toolBlock(collector, index);
  if (json.length > MAX_SSE_TOOL_ARGUMENT_CHARS - entry.argumentsJson.length) {
    throw protocolLimit("tool arguments", MAX_SSE_TOOL_ARGUMENT_CHARS);
  }
  if (json.length > MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS - collector.totalToolArgumentChars) {
    throw protocolLimit("total tool arguments", MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS);
  }
  entry.argumentsJson += json;
  collector.totalToolArgumentChars += json.length;
}

function collectedToolCalls(collector: BlockCollector): ProviderToolCall[] {
  return [...collector.toolBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, entry]) => ({
      id: entry.id || `call-${index + 1}`,
      name: entry.name,
      // A tool_use block whose input never arrived is still a call the loop has
      // to execute; an empty object is the only readable stand-in.
      argumentsJson: entry.argumentsJson || "{}",
    }));
}

export function mapAnthropicResponse(
  json: unknown,
  model: string,
  capabilities: ProviderCapabilities,
  modelPricing?: Record<string, ModelPricing>,
) {
  if (!isRecord(json)) {
    throw new ProviderProtocolError("Provider protocol error: response body must be an object");
  }
  if (json["type"] === "error" || json["error"] !== undefined) {
    const error = json["error"];
    const message = isRecord(error) && typeof error["message"] === "string" ? `: ${error["message"]}` : "";
    throw new ProviderProtocolError(`Provider protocol error: successful response contained an error${message}`);
  }
  const blocks = json["content"];
  if (!Array.isArray(blocks)) {
    throw new ProviderProtocolError("Provider protocol error: response has no content blocks");
  }
  const collector = createBlockCollector();
  let toolIndex = 0;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      addText(collector, block["text"]);
    } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
      addThinking(collector, block["thinking"]);
    } else if (block["type"] === "tool_use") {
      const entry = toolBlock(collector, toolIndex++);
      if (typeof block["id"] === "string") entry.id = block["id"];
      if (typeof block["name"] === "string") entry.name = block["name"];
      addToolArguments(collector, toolIndex - 1, JSON.stringify(block["input"] ?? {}));
    }
  }
  const rawStopReason = typeof json["stop_reason"] === "string" ? json["stop_reason"] : null;
  if (rawStopReason === "refusal" && collector.content === "") {
    addText(collector, refusalNotice(json["stop_details"]));
  }
  return {
    content: collector.content,
    toolCalls: collectedToolCalls(collector),
    finishReason: mapAnthropicStopReason(rawStopReason),
    usage: mapAnthropicUsage(json["usage"], model, capabilities, modelPricing),
    ...(collector.reasoningContent ? { reasoningContent: collector.reasoningContent } : {}),
  };
}

// --- streaming --------------------------------------------------------------

type AnthropicStreamState = SseFrameState & {
  collector: BlockCollector;
  rawStopReason: string | null;
  stopDetails: unknown;
  usage: AnthropicUsage;
  done: boolean;
};

/** Tolerate a missing/garbage index the way every accumulator here does: treat it as block 0. */
function blockIndex(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function mergeUsage(state: AnthropicStreamState, raw: unknown): void {
  if (!isRecord(raw)) return;
  for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    const value = raw[field];
    // Later events restate the running totals; an absent field is not a zero.
    if (typeof value === "number") state.usage[field as keyof AnthropicUsage] = value;
  }
}

function processEvent(
  state: AnthropicStreamState,
  event: Record<string, unknown>,
  onDelta?: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): void {
  switch (event["type"]) {
    case "message_start": {
      const message = event["message"];
      if (isRecord(message)) mergeUsage(state, message["usage"]);
      return;
    }
    case "content_block_start": {
      const block = event["content_block"];
      if (!isRecord(block) || block["type"] !== "tool_use") return;
      const entry = toolBlock(state.collector, blockIndex(event["index"]));
      if (typeof block["id"] === "string") entry.id = block["id"];
      if (typeof block["name"] === "string") entry.name = block["name"];
      return;
    }
    case "content_block_delta": {
      const delta = event["delta"];
      if (!isRecord(delta)) return;
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string" && delta["text"].length > 0) {
        addText(state.collector, delta["text"]);
        onDelta?.(delta["text"]);
        return;
      }
      if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string" && delta["thinking"].length > 0) {
        addThinking(state.collector, delta["thinking"]);
        onReasoningDelta?.(delta["thinking"]);
        return;
      }
      if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        addToolArguments(state.collector, blockIndex(event["index"]), delta["partial_json"]);
      }
      // signature_delta and any future block type carry nothing to display.
      return;
    }
    case "message_delta": {
      const delta = event["delta"];
      if (isRecord(delta)) {
        if (typeof delta["stop_reason"] === "string") state.rawStopReason = delta["stop_reason"];
        if (delta["stop_details"] !== undefined) state.stopDetails = delta["stop_details"];
      }
      mergeUsage(state, event["usage"]);
      return;
    }
    case "message_stop":
      state.done = true;
      return;
    case "error": {
      // An in-band error ends the response; the HTTP status was already 200, so
      // nothing else will report it.
      const error = event["error"];
      const message = isRecord(error) && typeof error["message"] === "string" ? `: ${error["message"]}` : "";
      throw new ProviderProtocolError(`Provider protocol error: stream reported an error${message}`);
    }
    default:
      return; // ping, content_block_stop, and anything added later
  }
}

function openAnthropicStream(
  model: string,
  capabilities: ProviderCapabilities,
  modelPricing?: Record<string, ModelPricing>,
): WireStreamSession {
  const state: AnthropicStreamState = {
    ...createSseFrameState(),
    collector: createBlockCollector(),
    rawStopReason: null,
    stopDetails: undefined,
    usage: {},
    done: false,
  };
  const handle = (payload: string, onDelta?: (d: string) => void, onReasoningDelta?: (d: string) => void): void => {
    if (state.done) return;
    const value = parseSsePayload(payload);
    if (!isRecord(value)) return;
    processEvent(state, value, onDelta, onReasoningDelta);
  };
  return {
    get done() {
      return state.done;
    },
    feed(chunk, onDelta, onReasoningDelta) {
      feedSseFrames(state, chunk, MAX_SSE_DECODED_CHARS, (payload) => handle(payload, onDelta, onReasoningDelta));
    },
    finish() {
      flushSseFrames(state, (payload) => handle(payload));
      if (!state.done) {
        throw new DeepSeekApiError("streaming response ended before message_stop");
      }
      const toolCalls = collectedToolCalls(state.collector);
      if (state.rawStopReason === "refusal" && state.collector.content === "") {
        addText(state.collector, refusalNotice(state.stopDetails));
      }
      return {
        content: state.collector.content,
        toolCalls,
        // A stream can deliver tool_use blocks and end without a stop_reason;
        // reporting "other" there would discard calls that were fully received.
        finishReason:
          state.rawStopReason === null && toolCalls.length > 0
            ? ("tool_calls" as ChatFinishReason)
            : mapAnthropicStopReason(state.rawStopReason),
        usage: mapAnthropicUsage(state.usage, model, capabilities, modelPricing),
        ...(state.collector.reasoningContent ? { reasoningContent: state.collector.reasoningContent } : {}),
      };
    },
  };
}

// --- protocol ---------------------------------------------------------------

export const anthropicProtocol: WireProtocol = {
  id: "anthropic",
  errorLabel: "Anthropic",
  endpoint: (baseUrl) => `${baseUrl}/messages`,
  headers: (apiKey) => ({
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  }),
  buildBody(model, req, stream, thinking, capabilities) {
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: withTailCacheBreakpoint(messages),
      stream,
    };
    // A cached system prompt has to be sent as a block: the string form has
    // nowhere to hang the breakpoint that covers it and the tool definitions.
    if (system !== undefined) body.system = [{ type: "text", text: system, cache_control: CACHE_CONTROL }];
    if (req.tools && req.tools.length > 0) body.tools = toAnthropicTools(req.tools);
    // `temperature` is deliberately never sent: the current model line rejects
    // sampling parameters outright, so forwarding one would fail every request
    // on exactly the models this preset exists to reach.
    if (!capabilities.thinking) return body;
    // KNOWN LIMITATION. When thinking is on, this protocol expects the client to
    // echo the assistant turn's thinking blocks back with the tool results that
    // answer it. A SeekForge ChatMessage has nowhere to keep them (role,
    // content, toolCalls, toolCallId — see @seekforge/shared), so they are not
    // replayed, and a tool-using turn may be rejected for the missing block.
    // Enabling thinking on a model whose default is off is therefore an opt-in
    // with that caveat; unset keeps the endpoint's own default, exactly as on
    // the DeepSeek line. Carrying the blocks through history is the real fix and
    // needs a shared type change.
    if (thinking.thinking !== undefined) {
      // Without display: "summarized" the thinking blocks stream with empty
      // text on current models, so the reasoning pane would sit blank for the
      // whole time the model is thinking.
      body.thinking = thinking.thinking ? { type: "adaptive", display: "summarized" } : { type: "disabled" };
    }
    if (thinking.reasoningEffort) {
      // Turning thinking off is only accepted at "high" effort or below.
      body.output_config = { effort: thinking.thinking === false ? "high" : thinking.reasoningEffort };
    }
    return body;
  },
  mapResponse: (json, model, capabilities, modelPricing) =>
    mapAnthropicResponse(json, model, capabilities, modelPricing),
  openStream: (model, capabilities, modelPricing) => openAnthropicStream(model, capabilities, modelPricing),
};

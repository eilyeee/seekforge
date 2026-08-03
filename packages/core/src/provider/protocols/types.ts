import type { ChatResponse } from "@seekforge/shared";
import type { ModelPricing } from "../constants.js";
import type { ThinkingOptions } from "../mapping.js";
import type { ChatRequest, ProviderCapabilities } from "../types.js";

/**
 * A wire protocol: everything that differs between the OpenAI-compatible
 * `/chat/completions` line and the Anthropic `/v1/messages` line.
 *
 * Deliberately narrow. Retries, the fallback model, timeouts, the response byte
 * ceiling, cancellation, and cache identity are protocol-independent and stay
 * in createDeepSeekProvider — one place where the network policy lives, so a
 * second protocol cannot quietly acquire a second policy. What a protocol owns
 * is the shape of the bytes: where to POST, how to authenticate, how to spell a
 * request, and how to read a response (whole or streamed).
 */
export interface WireProtocol {
  readonly id: WireProtocolId;
  /** Vendor name used in transport error messages ("… API error HTTP 401"). */
  readonly errorLabel: string;
  /** Full URL of the chat endpoint, from a base URL with no trailing slash. */
  endpoint(baseUrl: string): string;
  headers(apiKey: string): Record<string, string>;
  buildBody(
    model: string,
    req: ChatRequest,
    stream: boolean,
    thinking: ThinkingOptions,
    capabilities: ProviderCapabilities,
  ): Record<string, unknown>;
  /** Map a complete (non-streamed) response body. Throws ProviderProtocolError on a malformed one. */
  mapResponse(
    json: unknown,
    model: string,
    capabilities: ProviderCapabilities,
    modelPricing?: Record<string, ModelPricing>,
  ): ChatResponse;
  /** Open a streaming session; the caller feeds it decoded text and finishes it. */
  openStream(
    model: string,
    capabilities: ProviderCapabilities,
    modelPricing?: Record<string, ModelPricing>,
  ): WireStreamSession;
}

export type WireProtocolId = "openai" | "anthropic";

/**
 * One streaming response in progress. The accumulator behind it stays private
 * to the protocol: the provider only needs to push bytes in, know when the
 * protocol's terminator has arrived, and ask for the result.
 */
export type WireStreamSession = {
  /**
   * True once the protocol's end-of-stream marker has been seen. The provider
   * stops reading here rather than waiting for a peer that keeps the transport
   * open, and refuses to treat trailing bytes as more content.
   */
  readonly done: boolean;
  feed(chunk: string, onDelta?: (delta: string) => void, onReasoningDelta?: (delta: string) => void): void;
  /**
   * Flush any trailing partial line and produce the response. Throws when the
   * stream ended without its terminator — a dropped connection must not read as
   * a successful short answer.
   */
  finish(): ChatResponse;
};

import { buildRequestBody, mapChatResponse, mapUsage } from "../mapping.js";
import { createSseAccumulator, feedSseChunk, finalizeSse } from "../sse.js";
import { DeepSeekApiError } from "../http.js";
import type { WireProtocol } from "./types.js";

/**
 * The OpenAI-compatible chat-completions protocol — DeepSeek, Ark, OpenAI,
 * Ollama, OpenRouter.
 *
 * This is the protocol SeekForge grew up speaking, so it is a thin adapter over
 * the existing mapping/SSE modules rather than a reimplementation: the behavior
 * every provider test pins is still produced by the same code that produced it
 * before there was a second protocol.
 */
export const openaiProtocol: WireProtocol = {
  id: "openai",
  errorLabel: "DeepSeek",
  endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  headers: (apiKey) => ({ "content-type": "application/json", authorization: `Bearer ${apiKey}` }),
  buildBody: (model, req, stream, thinking, capabilities) =>
    buildRequestBody(model, req, stream, thinking, capabilities),
  mapResponse: (json, model, capabilities, modelPricing) => mapChatResponse(json, model, capabilities, modelPricing),
  openStream(model, capabilities, modelPricing) {
    const acc = createSseAccumulator();
    return {
      get done() {
        return acc.done;
      },
      feed(chunk, onDelta, onReasoningDelta) {
        feedSseChunk(acc, chunk, onDelta, onReasoningDelta);
      },
      finish() {
        // finalizeSse flushes a trailing line first, which can itself be the
        // terminator — so the completeness check has to come after it.
        const result = finalizeSse(acc);
        if (!acc.done) {
          throw new DeepSeekApiError("streaming response ended before [DONE]");
        }
        return {
          content: result.content,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
          usage: mapUsage(result.usage, model, capabilities, modelPricing),
          ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
        };
      },
    };
  },
};

import { anthropicProtocol } from "./anthropic.js";
import { openaiProtocol } from "./openai.js";
import type { WireProtocol, WireProtocolId } from "./types.js";

export type { WireProtocol, WireProtocolId, WireStreamSession } from "./types.js";
export { openaiProtocol } from "./openai.js";
export {
  anthropicProtocol,
  ANTHROPIC_VERSION,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  mapAnthropicResponse,
  mapAnthropicStopReason,
  mapAnthropicUsage,
  toAnthropicMessages,
  toAnthropicTools,
} from "./anthropic.js";

export const WIRE_PROTOCOLS: Record<WireProtocolId, WireProtocol> = {
  openai: openaiProtocol,
  anthropic: anthropicProtocol,
};

/**
 * OpenAI-compatible is the default for the same reason it always was: every
 * preset that predates a second protocol speaks it, and an unset field must not
 * change what those requests look like.
 */
export function resolveWireProtocol(id?: WireProtocolId): WireProtocol {
  return (id !== undefined ? WIRE_PROTOCOLS[id] : undefined) ?? openaiProtocol;
}

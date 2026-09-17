/**
 * Structured output: asking a model for a reply that is JSON matching a schema.
 *
 * What an endpoint can promise differs, so the provider says which promise it
 * makes (`ChatProvider.structuredOutput`) instead of pretending they are the
 * same:
 *
 * - `json_schema` — the endpoint constrains decoding to the schema: OpenAI's
 *   `response_format: { type: "json_schema" }` (strict), Anthropic's
 *   `output_config.format`. Both require every object in the schema to set
 *   `additionalProperties: false` and to list all its properties in
 *   `required`; a schema that does not is rejected with a 400.
 * - `json_object` — the reply is valid JSON, nothing more (DeepSeek). The
 *   schema must be stated in the prompt and the result checked by the caller;
 *   DeepSeek also requires the word "json" in the prompt.
 * - undefined — neither; `responseFormat` is not sent at all.
 *
 * In every case the caller still parses and validates the reply: a `length`
 * finish cuts JSON off mid-object, and a fallback model may make a weaker
 * promise than the primary.
 *
 * Sources, checked 2026-09-17: platform.claude.com/docs/en/build-with-claude/
 * structured-outputs (GA, Sonnet/Opus 4.5 and newer, Haiku 4.5);
 * api-docs.deepseek.com/api/create-chat-completion (`text` | `json_object`);
 * OpenAI structured outputs (gpt-4o and newer).
 */

import type { WireProtocolId } from "./protocols/types.js";
import type { ProviderCapabilities, ResponseFormat, StructuredOutputSupport } from "./types.js";

const ANTHROPIC_NO_STRUCTURED_OUTPUT =
  /^claude-(?:instant|[123])(?:[-.]|$)|^claude-(?:opus|sonnet)-4(?:-[01])?(?:-\d{8})?$/;
const OPENAI_STRUCTURED_OUTPUT = /^(?:gpt-4o|gpt-4\.1|gpt-5|o3|o4)(?:[-.]|$)/;

/** The promise this protocol/endpoint/model combination makes, if any. */
export function structuredOutputFor(
  protocol: WireProtocolId,
  capabilities: ProviderCapabilities,
  model: string,
): StructuredOutputSupport | undefined {
  const declared = capabilities.structuredOutput;
  if (declared === undefined) return undefined;
  const id = model.toLowerCase();
  if (protocol === "anthropic") {
    return declared === "json_schema" && !ANTHROPIC_NO_STRUCTURED_OUTPUT.test(id) ? "json_schema" : undefined;
  }
  if (declared === "json_schema") return OPENAI_STRUCTURED_OUTPUT.test(id) ? "json_schema" : undefined;
  return declared;
}

/** The OpenAI-compatible `response_format` field for a request, if one is sent. */
export function openAiResponseFormat(
  format: ResponseFormat,
  support: StructuredOutputSupport | undefined,
): Record<string, unknown> | undefined {
  if (support === "json_schema") {
    return {
      type: "json_schema",
      json_schema: { name: format.name, schema: format.schema, strict: format.strict ?? true },
    };
  }
  return support === "json_object" ? { type: "json_object" } : undefined;
}

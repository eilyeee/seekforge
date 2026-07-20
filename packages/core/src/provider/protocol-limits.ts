/** Shared response limits for streaming and non-streaming provider payloads. */
export const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_SSE_LINE_CHARS = 1024 * 1024;
export const MAX_SSE_DECODED_CHARS = 16 * 1024 * 1024;
export const MAX_SSE_CONTENT_CHARS = 4 * 1024 * 1024;
export const MAX_SSE_REASONING_CHARS = 8 * 1024 * 1024;
export const MAX_SSE_TOOL_ARGUMENT_CHARS = 1024 * 1024;
export const MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS = 4 * 1024 * 1024;
export const MAX_SSE_TOOL_CALLS = 128;

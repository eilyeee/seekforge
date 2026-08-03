/**
 * SSE line framing — the part of streaming that is the same for every wire
 * protocol.
 *
 * A network chunk can split a line anywhere, including between `dat` and `a:`,
 * so the carry-over buffer and the two length ceilings it protects (one line,
 * and the total decoded text) are what keep a hostile or broken stream from
 * growing without bound. That logic is identical whether the payloads are
 * OpenAI chat-completion chunks or Anthropic message events; only the meaning
 * of each payload differs. This module owns the framing and hands each `data:`
 * payload to the protocol that knows how to read it.
 */

import { ProviderProtocolError } from "./mapping.js";
import { MAX_SSE_LINE_CHARS } from "./protocol-limits.js";

export type SseFrameState = {
  /** Carry-over for a partial line split across network chunks. */
  buffer: string;
  decodedChars: number;
};

export function createSseFrameState(): SseFrameState {
  return { buffer: "", decodedChars: 0 };
}

export function protocolLimit(label: string, limit: number): ProviderProtocolError {
  return new ProviderProtocolError(`Provider protocol error: SSE ${label} exceeds ${limit}`);
}

/** Strip the SSE field prefix; non-`data:` lines (comments, `event:`) carry nothing we need. */
function emitPayload(rawLine: string, onPayload: (payload: string) => void): void {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith("data:")) return;
  const payload = line.slice("data:".length).trim();
  if (payload === "") return;
  onPayload(payload);
}

/**
 * Feed a decoded text chunk. Complete lines are handed to `onPayload`; the
 * remainder is buffered for the next chunk.
 */
export function feedSseFrames(
  state: SseFrameState,
  chunk: string,
  maxDecodedChars: number,
  onPayload: (payload: string) => void,
): void {
  if (chunk.length > maxDecodedChars - state.decodedChars) {
    throw protocolLimit("decoded content", maxDecodedChars);
  }
  state.decodedChars += chunk.length;
  let offset = 0;
  while (offset < chunk.length) {
    const newlineIdx = chunk.indexOf("\n", offset);
    const end = newlineIdx === -1 ? chunk.length : newlineIdx;
    const fragmentLength = end - offset;
    if (state.buffer.length + fragmentLength > MAX_SSE_LINE_CHARS) {
      throw protocolLimit("line", MAX_SSE_LINE_CHARS);
    }
    state.buffer += chunk.slice(offset, end);
    if (newlineIdx === -1) return;

    const line = state.buffer;
    state.buffer = "";
    emitPayload(line, onPayload);
    offset = newlineIdx + 1;
  }
}

/** Flush a trailing line that arrived without a final newline. */
export function flushSseFrames(state: SseFrameState, onPayload: (payload: string) => void): void {
  if (state.buffer.length === 0) return;
  const rest = state.buffer;
  state.buffer = "";
  emitPayload(rest, onPayload);
}

/** Parse one payload, tolerating garbage lines the way every SSE peer must. */
export function parseSsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

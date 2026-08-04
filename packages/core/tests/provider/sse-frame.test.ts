import { describe, expect, it } from "vitest";
import { createSseFrameState, feedSseFrames, flushSseFrames, parseSsePayload } from "../../src/provider/sse-frame.js";
import { MAX_SSE_LINE_CHARS } from "../../src/provider/protocol-limits.js";

/**
 * The line framing every provider stream goes through.
 *
 * It had no test of its own: the OpenAI and Anthropic dialect suites exercise
 * it incidentally, with well-formed streams. But this is the code that reads
 * bytes off a socket, so the cases worth pinning are the ones a well-formed
 * stream never produces — a line split between `dat` and `a:`, a payload that
 * never ends, a chunk that arrives after the ceiling is already reached.
 */

/** Collect payloads from a sequence of network chunks. */
function feed(chunks: string[], maxDecoded = 1_000_000): string[] {
  const state = createSseFrameState();
  const out: string[] = [];
  for (const chunk of chunks) feedSseFrames(state, chunk, maxDecoded, (p) => out.push(p));
  flushSseFrames(state, (p) => out.push(p));
  return out;
}

describe("sse framing", () => {
  it("reassembles a line split anywhere, including inside the field name", () => {
    // The comment at the top of the module names this exact case; a chunk
    // boundary respects nothing.
    expect(feed(["dat", "a: {", '"a":1}', "\n"])).toEqual(['{"a":1}']);
    expect(feed(["data: 1\nda", "ta: 2\n"])).toEqual(["1", "2"]);
    expect(feed(['data: {"x"', ":", '"y"}', "\n"])).toEqual(['{"x":"y"}']);
  });

  it("emits nothing for the fields that carry nothing", () => {
    // `event:` and comments are part of SSE and mean nothing to a payload
    // reader; a blank data line is a keep-alive, not an empty message.
    expect(feed([": keep-alive\nevent: message\ndata: {}\n\ndata:   \n"])).toEqual(["{}"]);
  });

  it("handles CRLF, which some proxies insert", () => {
    expect(feed(["data: one\r\ndata: two\r\n"])).toEqual(["one", "two"]);
  });

  it("delivers a final line that never got its newline", () => {
    // A stream can end mid-line. Without the flush the last event — often the
    // one carrying the finish reason — would be silently dropped.
    const state = createSseFrameState();
    const out: string[] = [];
    feedSseFrames(state, "data: last", 1000, (p) => out.push(p));
    expect(out).toEqual([]);
    flushSseFrames(state, (p) => out.push(p));
    expect(out).toEqual(["last"]);
  });

  it("flushes only once, so a second flush cannot replay the last event", () => {
    const state = createSseFrameState();
    const out: string[] = [];
    feedSseFrames(state, "data: once", 1000, () => {});
    flushSseFrames(state, (p) => out.push(p));
    flushSseFrames(state, (p) => out.push(p));
    expect(out).toEqual(["once"]);
  });

  it("refuses a line that never ends", () => {
    // A peer that sends megabytes without a newline would otherwise grow the
    // carry-over buffer without bound. The ceiling is checked against the
    // buffer PLUS the incoming fragment, so it cannot be walked past in small
    // steps either.
    const state = createSseFrameState();
    const chunk = "x".repeat(MAX_SSE_LINE_CHARS / 4);
    expect(() => {
      for (let i = 0; i < 8; i++) feedSseFrames(state, chunk, 100_000_000, () => {});
    }).toThrow(/SSE line exceeds/);
  });

  it("refuses more decoded text than the caller allowed", () => {
    const state = createSseFrameState();
    feedSseFrames(state, "data: a\n", 20, () => {});
    // The budget is cumulative across chunks, not per chunk.
    expect(() => feedSseFrames(state, "data: bbbbbbbbbbbbbb\n", 20, () => {})).toThrow(/decoded content exceeds 20/);
  });

  it("counts every byte toward the budget, not just the payloads", () => {
    // Comments and event: lines carry no payload but do carry cost; a stream of
    // pure keep-alives must still be bounded.
    const state = createSseFrameState();
    expect(() => feedSseFrames(state, ": ".padEnd(50, "x") + "\n", 20, () => {})).toThrow(/decoded content/);
  });

  it("tolerates garbage payloads the way every SSE peer must", () => {
    expect(parseSsePayload('{"ok":true}')).toEqual({ ok: true });
    expect(parseSsePayload("[DONE]")).toBeUndefined();
    expect(parseSsePayload("")).toBeUndefined();
    expect(parseSsePayload("{unterminated")).toBeUndefined();
  });

  it("keeps its own state, so two streams cannot bleed into each other", () => {
    const a = createSseFrameState();
    const b = createSseFrameState();
    const outA: string[] = [];
    const outB: string[] = [];
    feedSseFrames(a, "data: aaa", 1000, (p) => outA.push(p));
    feedSseFrames(b, "data: bbb\n", 1000, (p) => outB.push(p));
    flushSseFrames(a, (p) => outA.push(p));
    expect(outA).toEqual(["aaa"]);
    expect(outB).toEqual(["bbb"]);
  });
});

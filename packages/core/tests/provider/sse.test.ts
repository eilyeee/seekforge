import { describe, expect, it } from "vitest";
import {
  createSseAccumulator,
  feedSseChunk,
  finalizeSse,
} from "../../src/provider/sse.js";

const TRANSCRIPT = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}',
  "",
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "",
  'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":64,"prompt_cache_miss_tokens":36}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

describe("SSE accumulation", () => {
  it("accumulates content deltas and emits onDelta per delta", () => {
    const acc = createSseAccumulator();
    const deltas: string[] = [];
    feedSseChunk(acc, TRANSCRIPT, (d) => deltas.push(d));
    const result = finalizeSse(acc);
    expect(deltas).toEqual(["Hel", "lo", " world"]);
    expect(result.content).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_cache_hit_tokens: 64,
      prompt_cache_miss_tokens: 36,
    });
    expect(acc.done).toBe(true);
  });

  it("handles data lines split across arbitrary chunk boundaries", () => {
    const acc = createSseAccumulator();
    const deltas: string[] = [];
    // Split mid-line, mid-JSON, mid-keyword.
    for (let i = 0; i < TRANSCRIPT.length; i += 7) {
      feedSseChunk(acc, TRANSCRIPT.slice(i, i + 7), (d) => deltas.push(d));
    }
    const result = finalizeSse(acc);
    expect(deltas.join("")).toBe("Hello world");
    expect(result.content).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.prompt_tokens).toBe(100);
  });

  it("accumulates tool_call deltas by index", () => {
    const transcript = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\": \\"Tokyo\\"}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_def","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const acc = createSseAccumulator();
    const deltas: string[] = [];
    feedSseChunk(acc, transcript, (d) => deltas.push(d));
    const result = finalizeSse(acc);
    expect(deltas).toEqual([]); // null/absent content emits no deltas
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", argumentsJson: '{"city": "Tokyo"}' },
      { id: "call_def", name: "read_file", argumentsJson: '{"path":"a.txt"}' },
    ]);
  });

  it("tolerates CRLF line endings and non-data lines", () => {
    const acc = createSseAccumulator();
    const transcript =
      ": keep-alive comment\r\n" +
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\r\n' +
      "\r\n" +
      "data: [DONE]\r\n";
    feedSseChunk(acc, transcript);
    const result = finalizeSse(acc);
    expect(result.content).toBe("hi");
    expect(acc.done).toBe(true);
  });

  it("ignores unparsable data payloads", () => {
    const acc = createSseAccumulator();
    feedSseChunk(acc, "data: {not json}\n" + 'data: {"choices":[{"delta":{"content":"ok"}}]}\n');
    expect(finalizeSse(acc).content).toBe("ok");
  });

  it("maps an unknown finish_reason to other", () => {
    const acc = createSseAccumulator();
    feedSseChunk(acc, 'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n');
    expect(finalizeSse(acc).finishReason).toBe("other");
  });

  it("processes a trailing line without a final newline at finalize", () => {
    const acc = createSseAccumulator();
    feedSseChunk(acc, 'data: {"choices":[{"delta":{"content":"tail"}}]}');
    expect(finalizeSse(acc).content).toBe("tail");
  });
});

describe("streaming reasoning_content", () => {
  it("accumulates reasoning deltas separately and fires the callback", async () => {
    const { createSseAccumulator, feedSseChunk, finalizeSse } = await import("../../src/provider/sse.js");
    const acc = createSseAccumulator();
    const content: string[] = [];
    const reasoning: string[] = [];
    const lines = [
      'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    feedSseChunk(acc, lines, (d) => content.push(d), (d) => reasoning.push(d));
    const result = finalizeSse(acc);
    expect(reasoning.join("")).toBe("think hard");
    expect(content.join("")).toBe("answer");
    expect(result.reasoningContent).toBe("think hard");
    expect(result.content).toBe("answer");
  });
});

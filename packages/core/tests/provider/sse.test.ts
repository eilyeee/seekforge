import { describe, expect, it } from "vitest";
import { createSseAccumulator, feedSseChunk, finalizeSse, MAX_SSE_LINE_CHARS } from "../../src/provider/sse.js";
import { ProviderProtocolError } from "../../src/provider/mapping.js";

function deltaLine(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;
}

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

  it.each(["null", "[]", '"text"', "42"])("ignores valid JSON non-object payload %s", (payload) => {
    const acc = createSseAccumulator();
    feedSseChunk(acc, `data: ${payload}\n` + 'data: {"choices":[{"delta":{"content":"ok"}}]}\n');
    expect(finalizeSse(acc).content).toBe("ok");
  });

  it("ignores malformed nested choices and tool calls", () => {
    const acc = createSseAccumulator();
    feedSseChunk(
      acc,
      [
        'data: {"choices":"bad"}',
        'data: {"choices":[{"delta":{"tool_calls":[null,42,{"index":-1,"function":"bad"}]}}]}',
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
      ].join("\n") + "\n",
    );
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

  it("treats [DONE] as final and ignores trailing provider data", () => {
    const acc = createSseAccumulator();
    const deltas: string[] = [];
    feedSseChunk(
      acc,
      [
        'data: {"choices":[{"delta":{"content":"accepted"}}]}',
        "data: [DONE]",
        'data: {"choices":[{"delta":{"content":" rejected"}}]}',
        "",
      ].join("\n"),
      (delta) => deltas.push(delta),
    );

    expect(finalizeSse(acc).content).toBe("accepted");
    expect(deltas).toEqual(["accepted"]);
  });

  it("rejects a newline-free line before the carry-over buffer can grow unbounded", () => {
    const acc = createSseAccumulator();
    feedSseChunk(acc, "x".repeat(MAX_SSE_LINE_CHARS));

    expect(() => feedSseChunk(acc, "x")).toThrow(/SSE line exceeds/);
    expect(acc.buffer).toHaveLength(MAX_SSE_LINE_CHARS);
  });

  it("preserves a valid event fragmented at the maximum line size", () => {
    const acc = createSseAccumulator();
    const prefix = 'data: {"choices":[{"delta":{"content":"bounded"}}]}';
    const line = prefix + " ".repeat(MAX_SSE_LINE_CHARS - prefix.length);

    for (let offset = 0; offset < line.length; offset += 8191) {
      feedSseChunk(acc, line.slice(offset, offset + 8191));
    }
    feedSseChunk(acc, "\n");

    expect(finalizeSse(acc).content).toBe("bounded");
    expect(acc.buffer).toBe("");
  });

  it("rejects aggregate decoded text before appending the excess chunk", () => {
    const acc = createSseAccumulator({ decodedChars: 5 });
    feedSseChunk(acc, "12345");

    expect(() => feedSseChunk(acc, "6")).toThrow(ProviderProtocolError);
    expect(acc.decodedChars).toBe(5);
  });

  it("bounds accumulated content and reasoning independently", () => {
    const content = createSseAccumulator({ decodedChars: 10_000, contentChars: 3 });
    const contentDeltas: string[] = [];
    feedSseChunk(content, deltaLine({ content: "ab" }), (value) => contentDeltas.push(value));
    expect(() => feedSseChunk(content, deltaLine({ content: "cd" }), (value) => contentDeltas.push(value))).toThrow(
      /SSE content exceeds 3/,
    );
    expect(content.content).toBe("ab");
    expect(contentDeltas).toEqual(["ab"]);

    const reasoning = createSseAccumulator({ decodedChars: 10_000, reasoningChars: 3 });
    const reasoningDeltas: string[] = [];
    feedSseChunk(reasoning, deltaLine({ reasoning_content: "ab" }), undefined, (value) => reasoningDeltas.push(value));
    expect(() =>
      feedSseChunk(reasoning, deltaLine({ reasoning_content: "cd" }), undefined, (value) =>
        reasoningDeltas.push(value),
      ),
    ).toThrow(/SSE reasoning content exceeds 3/);
    expect(reasoning.reasoningContent).toBe("ab");
    expect(reasoningDeltas).toEqual(["ab"]);
  });

  it("bounds per-call and aggregate tool arguments", () => {
    const toolDelta = (index: number, argumentsJson: string) =>
      deltaLine({ tool_calls: [{ index, function: { arguments: argumentsJson } }] });

    const perCall = createSseAccumulator({
      decodedChars: 10_000,
      toolArgumentChars: 3,
      totalToolArgumentChars: 10,
    });
    feedSseChunk(perCall, toolDelta(0, "ab"));
    expect(() => feedSseChunk(perCall, toolDelta(0, "cd"))).toThrow(/SSE tool arguments exceeds 3/);
    expect(perCall.toolCallsByIndex.get(0)?.argumentsJson).toBe("ab");

    const aggregate = createSseAccumulator({
      decodedChars: 10_000,
      toolArgumentChars: 10,
      totalToolArgumentChars: 3,
    });
    feedSseChunk(aggregate, toolDelta(0, "ab"));
    expect(() => feedSseChunk(aggregate, toolDelta(1, "cd"))).toThrow(/SSE total tool arguments exceeds 3/);
    expect(aggregate.totalToolArgumentChars).toBe(2);
  });

  it("bounds the number of distinct streamed tool calls", () => {
    const acc = createSseAccumulator({ decodedChars: 10_000, toolCalls: 1 });
    feedSseChunk(acc, deltaLine({ tool_calls: [{ index: 0, function: { name: "first" } }] }));

    expect(() => feedSseChunk(acc, deltaLine({ tool_calls: [{ index: 1, function: { name: "second" } }] }))).toThrow(
      /SSE tool call count exceeds 1/,
    );
    expect(acc.toolCallsByIndex.size).toBe(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])("rejects an invalid custom limit: %s", (limit) => {
    expect(() => createSseAccumulator({ decodedChars: limit })).toThrow(RangeError);
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
    feedSseChunk(
      acc,
      lines,
      (d) => content.push(d),
      (d) => reasoning.push(d),
    );
    const result = finalizeSse(acc);
    expect(reasoning.join("")).toBe("think hard");
    expect(content.join("")).toBe("answer");
    expect(result.reasoningContent).toBe("think hard");
    expect(result.content).toBe("answer");
  });
});

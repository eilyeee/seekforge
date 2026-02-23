import { describe, expect, it } from "vitest";
import {
  buildFallbackToolPrompt,
  parseFallbackToolCalls,
} from "../../src/provider/fallback.js";

describe("parseFallbackToolCalls", () => {
  it("parses a single valid block", () => {
    const text = [
      "```tool_call",
      '{"name": "read_file", "arguments": {"path": "src/App.tsx"}}',
      "```",
    ].join("\n");
    const calls = parseFallbackToolCalls(text);
    expect(calls).toEqual([
      { id: "fallback-1", name: "read_file", argumentsJson: '{"path":"src/App.tsx"}' },
    ]);
  });

  it("parses multiple blocks with surrounding prose", () => {
    const text = [
      "I will first read the file, then check the weather.",
      "",
      "```tool_call",
      '{"name": "read_file", "arguments": {"path": "a.txt"}}',
      "```",
      "",
      "And then:",
      "",
      "```tool_call",
      '  {"name": "get_weather", "arguments": {"city": "Tokyo"}}  ',
      "```",
      "",
      "Done.",
    ].join("\n");
    const calls = parseFallbackToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["read_file", "get_weather"]);
    expect(calls.map((c) => c.id)).toEqual(["fallback-1", "fallback-2"]);
    expect(JSON.parse(calls[1]!.argumentsJson)).toEqual({ city: "Tokyo" });
  });

  it("tolerates whitespace around the language tag and CRLF", () => {
    const text = "```  tool_call \r\n{\"name\": \"ls\", \"arguments\": {}}\r\n```";
    const calls = parseFallbackToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("ls");
  });

  it("ignores malformed JSON blocks but keeps valid ones", () => {
    const text = [
      "```tool_call",
      '{"name": "broken", "arguments": {oops}',
      "```",
      "```tool_call",
      '{"name": "ok", "arguments": {"x": 1}}',
      "```",
    ].join("\n");
    const calls = parseFallbackToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "fallback-1", name: "ok", argumentsJson: '{"x":1}' });
  });

  it("ignores blocks without a string name", () => {
    const text = ["```tool_call", '{"arguments": {"x": 1}}', "```"].join("\n");
    expect(parseFallbackToolCalls(text)).toEqual([]);
  });

  it("defaults missing arguments to an empty object", () => {
    const text = ["```tool_call", '{"name": "noop"}', "```"].join("\n");
    expect(parseFallbackToolCalls(text)[0]!.argumentsJson).toBe("{}");
  });

  it("returns empty for plain prose and other code fences", () => {
    expect(parseFallbackToolCalls("just some text")).toEqual([]);
    expect(parseFallbackToolCalls('```json\n{"name": "x", "arguments": {}}\n```')).toEqual([]);
  });
});

describe("buildFallbackToolPrompt", () => {
  it("includes tool docs and the block format", () => {
    const prompt = buildFallbackToolPrompt([
      {
        name: "read_file",
        description: "Read a file from the workspace.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    expect(prompt).toContain("```tool_call");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("Read a file from the workspace.");
    expect(prompt).toContain('"path"');
  });
});

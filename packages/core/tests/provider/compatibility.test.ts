import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../../src/provider/index.js";
import { buildRequestBody, mapChatResponse, mapUsage } from "../../src/provider/mapping.js";
import { PROVIDER_PRESETS, resolveProviderConfig } from "../../src/provider/presets.js";

type RecordedRequest = { path: string; authorization: string | undefined; body: Record<string, unknown> };

const recorded: RecordedRequest[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      recorded.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(body) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "transport-ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2, prompt_cache_hit_tokens: 3 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("provider compatibility matrix", () => {
  it.each(Object.entries(PROVIDER_PRESETS))("keeps %s request and accounting semantics explicit", (name, preset) => {
    const model = preset.models[0]!;
    const body = buildRequestBody(
      model,
      {
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ name: "inspect", description: "Inspect", parameters: { type: "object" } }],
      },
      true,
      { thinking: true, reasoningEffort: "high" },
      preset.capabilities,
    );

    expect(body).toMatchObject({ model, stream: true, stream_options: { include_usage: true } });
    expect(body.tools).toHaveLength(1);
    if (name === "deepseek") expect(body.thinking).toEqual({ type: "enabled", reasoning_effort: "high" });
    else expect(body).not.toHaveProperty("thinking");

    const usage = mapUsage(
      { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 6 },
      model,
      preset.capabilities,
    );
    if (name === "deepseek") {
      expect(usage.cacheHitTokens).toBe(6);
      expect(usage.costUsd).toBeGreaterThan(0);
    } else {
      expect(usage.cacheHitTokens).toBe(0);
      expect(usage.costUsd).toBe(0);
    }
  });

  it.each(Object.keys(PROVIDER_PRESETS))("maps OpenAI-compatible tool calls for %s", (name) => {
    const preset = PROVIDER_PRESETS[name]!;
    const response = mapChatResponse(
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      preset.models[0]!,
      preset.capabilities,
    );
    expect(response.toolCalls).toEqual([{ id: "call-1", name: "inspect", argumentsJson: "{}" }]);
    expect(response.finishReason).toBe("tool_calls");
  });

  it.each(Object.keys(PROVIDER_PRESETS))("completes a real HTTP/SSE request for %s", async (name) => {
    const preset = PROVIDER_PRESETS[name]!;
    const provider = createDeepSeekProvider(
      resolveProviderConfig({
        provider: name,
        apiKey: `${name}-key`,
        baseUrl,
        model: preset.models[0]!,
        thinking: true,
        reasoningEffort: "high",
      }),
    );
    const deltas: string[] = [];

    const result = await provider.chatStream({ messages: [{ role: "user", content: "transport check" }] }, (delta) =>
      deltas.push(delta),
    );

    expect(deltas).toEqual(["transport-ok"]);
    expect(result.content).toBe("transport-ok");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.promptTokens).toBe(5);
    expect(result.usage.completionTokens).toBe(2);
    expect(result.usage.cacheHitTokens).toBe(name === "deepseek" ? 3 : 0);

    const request = recorded.at(-1)!;
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.authorization).toBe(`Bearer ${name}-key`);
    expect(request.body).toMatchObject({ model: preset.models[0], stream: true });
    if (name === "deepseek") {
      expect(request.body.thinking).toEqual({ type: "enabled", reasoning_effort: "high" });
    } else {
      expect(request.body).not.toHaveProperty("thinking");
    }
  });
});

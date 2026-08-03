import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, PermissionRequest, TokenUsage } from "@seekforge/shared";
import { createMcpClient } from "../../src/mcp/client.js";
import { createMcpElicitationHandler, createMcpSamplingHandler } from "../../src/mcp/handlers.js";
import {
  clientCapabilities,
  createServerRequestResponder,
  parseElicitationRequest,
  parseSamplingRequest,
  type McpServerRequestHandlers,
} from "../../src/mcp/server-requests.js";
import { writeFixtureServer } from "./fixture.js";

/**
 * The two requests that travel server → client. The fixture server issues both
 * for real over stdio, so the round trip — advertise the capability, validate
 * the request, ask the user, answer the server — is exercised end to end, not
 * just unit by unit.
 */

const usage: TokenUsage = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.0002 };

function fakeProvider(overrides: { content?: string; model?: string } = {}) {
  const calls: Array<{ messages: ChatMessage[]; maxTokens?: number }> = [];
  return {
    calls,
    provider: {
      model: overrides.model ?? "test-model",
      async chat(req: { messages: ChatMessage[]; maxTokens?: number }) {
        calls.push({ messages: req.messages, ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}) });
        return { content: overrides.content ?? "a summary", usage, finishReason: "stop" as const };
      },
    },
  };
}

describe("advertised capabilities", () => {
  it("offers only roots when nothing is wired", () => {
    expect(clientCapabilities()).toEqual({ roots: { listChanged: true } });
    expect(clientCapabilities({})).toEqual({ roots: { listChanged: true } });
  });

  it("offers a capability exactly when its handler exists", () => {
    const handlers: McpServerRequestHandlers = {
      sampling: async () => ({ text: "", model: "m" }),
    };
    expect(clientCapabilities(handlers)).toEqual({ roots: { listChanged: true }, sampling: {} });
    expect(clientCapabilities({ ...handlers, elicitation: async () => ({ action: "decline" }) })).toEqual({
      roots: { listChanged: true },
      sampling: {},
      elicitation: {},
    });
  });
});

describe("validating what a server sends", () => {
  it("accepts a well-formed sampling request and normalizes its content", () => {
    const request = parseSamplingRequest("docs", {
      messages: [
        { role: "user", content: { type: "text", text: "hello" } },
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "image", data: "…" },
          ],
        },
      ],
      systemPrompt: "be brief",
      maxTokens: 42.7,
      modelPreferences: { hints: [{ name: "fast-model" }, { nope: 1 }] },
    });
    expect(request).toEqual({
      server: "docs",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
      ],
      systemPrompt: "be brief",
      maxTokens: 42,
      modelHints: ["fast-model"],
    });
  });

  it.each([
    ["no messages", { messages: [] }],
    ["a bad role", { messages: [{ role: "system", content: { type: "text", text: "x" } }] }],
    ["no text content", { messages: [{ role: "user", content: [{ type: "image", data: "x" }] }] }],
    ["too many messages", { messages: Array.from({ length: 51 }, () => ({ role: "user", content: "x" })) }],
    ["an oversized prompt", { messages: [{ role: "user", content: { type: "text", text: "x".repeat(200_001) } }] }],
  ])("rejects a sampling request with %s", (_label, params) => {
    expect(() => parseSamplingRequest("docs", params)).toThrow();
  });

  it("accepts a flat elicitation schema and describes each field", () => {
    const request = parseElicitationRequest("deploy", {
      message: "Deploy to production?",
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Confirm" },
          env: { type: "string", enum: ["staging", "production"], description: "Target" },
        },
        required: ["confirm"],
      },
    });
    expect(request.fields).toEqual([
      { name: "confirm", type: "boolean", title: "Confirm", required: true },
      { name: "env", type: "string", description: "Target", options: ["staging", "production"], required: false },
    ]);
  });

  it.each([
    ["a nested field", { properties: { nested: { type: "object" } } }],
    ["an array field", { properties: { many: { type: "array" } } }],
    ["no properties", { properties: {} }],
  ])("rejects an elicitation schema with %s", (_label, schema) => {
    expect(() =>
      parseElicitationRequest("deploy", { message: "hi", requestedSchema: { type: "object", ...schema } }),
    ).toThrow();
  });
});

describe("answering a server request", () => {
  const respond = (handlers?: McpServerRequestHandlers) =>
    createServerRequestResponder({ name: "docs", workspaceRoots: ["/tmp/ws"], handlers });

  it("answers roots/list from the configured workspace", async () => {
    const reply = await respond()(1, "roots/list", {});
    expect(reply).toMatchObject({ id: 1, result: { roots: [{ name: "workspace" }] } });
  });

  it("reports method-not-found for a capability that was never advertised", async () => {
    for (const method of ["sampling/createMessage", "elicitation/create", "something/else"]) {
      const reply = await respond()("x", method, {});
      expect(reply).toMatchObject({ error: { code: -32601 } });
    }
  });

  it("reports invalid params rather than running a malformed request", async () => {
    let called = false;
    const reply = await respond({
      sampling: async () => {
        called = true;
        return { text: "", model: "m" };
      },
    })(2, "sampling/createMessage", { messages: [] });
    expect(reply).toMatchObject({ error: { code: -32602 } });
    expect(called).toBe(false);
  });

  it("turns a handler failure into an error the server can act on, never a hang", async () => {
    const reply = await respond({
      sampling: async () => {
        throw new Error("the user declined");
      },
    })(3, "sampling/createMessage", { messages: [{ role: "user", content: "hi" }] });
    expect(reply).toMatchObject({ error: { code: -32603, message: "the user declined" } });
  });

  it("refuses a server that piles up requests instead of queueing prompts", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responder = respond({
      sampling: async () => {
        await held;
        return { text: "done", model: "m" };
      },
    });
    const sample = (id: number) =>
      responder(id, "sampling/createMessage", { messages: [{ role: "user", content: "x" }] });

    const pending = [sample(1), sample(2), sample(3), sample(4)];
    const overflow = await sample(5);
    expect(overflow).toMatchObject({ error: { code: -32603, message: expect.stringContaining("too many") } });

    // Once the held ones drain, the next request is served normally again.
    release();
    await Promise.all(pending);
    expect(await sample(6)).toMatchObject({ result: { model: "m" } });
  });

  it("shapes a sampling result the way the protocol expects", async () => {
    const reply = await respond({
      sampling: async () => ({ text: "done", model: "test-model", stopReason: "stop" }),
    })(4, "sampling/createMessage", { messages: [{ role: "user", content: "hi" }] });
    expect(reply).toMatchObject({
      result: { role: "assistant", content: { type: "text", text: "done" }, model: "test-model", stopReason: "stop" },
    });
  });
});

describe("running a sampling request on the user's model", () => {
  it("asks first, and sends the server's prompt to the model when approved", async () => {
    const { provider, calls } = fakeProvider();
    const prompts: PermissionRequest[] = [];
    const reported: TokenUsage[] = [];
    const handler = createMcpSamplingHandler({
      provider: () => provider,
      confirm: async (request) => {
        prompts.push(request);
        return true;
      },
      onUsage: (u) => reported.push(u),
    });

    const result = await handler({
      server: "docs",
      messages: [{ role: "user", text: "summarize this" }],
      systemPrompt: "be brief",
      maxTokens: 100,
    });

    expect(result).toEqual({ text: "a summary", model: "test-model", stopReason: "stop" });
    expect(calls[0]?.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "summarize this" },
    ]);
    expect(calls[0]?.maxTokens).toBe(100);
    // The user is told which server asked, which model pays, and what it says.
    expect(prompts[0]?.permission).toBe("env");
    expect(prompts[0]?.description).toContain('server "docs"');
    expect(prompts[0]?.description).toContain("test-model");
    expect(prompts[0]?.description).toContain("summarize this");
    expect(reported).toEqual([usage]);
  });

  it("does not call the model when the user declines", async () => {
    const { provider, calls } = fakeProvider();
    const handler = createMcpSamplingHandler({ provider: () => provider, confirm: async () => false });
    await expect(handler({ server: "docs", messages: [{ role: "user", text: "hi" }] })).rejects.toThrow(/declined/);
    expect(calls).toHaveLength(0);
  });

  it("declines when no model is configured for the session", async () => {
    const handler = createMcpSamplingHandler({ provider: () => undefined, confirm: async () => true });
    await expect(handler({ server: "docs", messages: [{ role: "user", text: "hi" }] })).rejects.toThrow(/no model/);
  });
});

describe("putting a server's question to the user", () => {
  it("collects boolean and enum answers", async () => {
    const asked: string[] = [];
    const handler = createMcpElicitationHandler({
      askUser: async ({ question, options }) => {
        asked.push(question);
        return options[0]!;
      },
    });

    const result = await handler({
      server: "deploy",
      message: "Deploy to production?",
      fields: [
        { name: "confirm", type: "boolean", required: true },
        { name: "env", type: "string", options: ["staging", "production"], required: true },
      ],
    });

    expect(result).toEqual({ action: "accept", content: { confirm: true, env: "staging" } });
    expect(asked[0]).toContain("Deploy to production?");
  });

  it("declines the whole request as soon as the user declines one field", async () => {
    const handler = createMcpElicitationHandler({ askUser: async ({ options }) => options.at(-1)! });
    const result = await handler({
      server: "deploy",
      message: "Deploy?",
      fields: [{ name: "confirm", type: "boolean", required: true }],
    });
    expect(result).toEqual({ action: "decline" });
  });

  it("keeps its refusal option distinct from an enum that says Decline", async () => {
    const seen: string[][] = [];
    const handler = createMcpElicitationHandler({
      askUser: async ({ options }) => {
        seen.push(options);
        return "Decline";
      },
    });

    const result = await handler({
      server: "deploy",
      message: "Pick an action",
      fields: [{ name: "action", type: "string", options: ["Approve", "Decline"], required: true }],
    });

    // Choosing the server's own "Decline" value is an ANSWER, not a refusal.
    expect(result).toEqual({ action: "accept", content: { action: "Decline" } });
    expect(seen[0]).toEqual(["Approve", "Decline", "Decline (do not answer)"]);
  });

  it("refuses a free-text field instead of inventing a value", async () => {
    let asked = 0;
    const handler = createMcpElicitationHandler({
      askUser: async ({ options }) => {
        asked++;
        return options[0]!;
      },
    });
    await expect(
      handler({
        server: "deploy",
        message: "Which account?",
        fields: [{ name: "account", type: "string", required: true }],
      }),
    ).rejects.toThrow(/free-form/);
    expect(asked).toBe(0);
  });
});

describe("over a real stdio connection", () => {
  let fixture: ReturnType<typeof writeFixtureServer>;

  beforeEach(() => {
    fixture = writeFixtureServer();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  const connect = (handlers?: McpServerRequestHandlers) =>
    createMcpClient({
      name: "fixture",
      config: { command: process.execPath, args: [fixture.serverPath], trusted: true },
      ...(handlers ? { serverRequestHandlers: handlers } : {}),
    });

  it("tells an unwired server it cannot sample or elicit", async () => {
    const client = connect();
    try {
      const advertised = JSON.parse(await client.callTool("__getRoots", {})) as {
        capabilities: Record<string, unknown>;
      };
      expect(advertised.capabilities).toEqual({ roots: { listChanged: true } });

      const answer = JSON.parse(await client.callTool("__sample", {})) as { error?: { code: number } };
      expect(answer.error?.code).toBe(-32601);
    } finally {
      client.dispose();
    }
  });

  it("runs the model for a wired server and returns the completion", async () => {
    const { provider, calls } = fakeProvider({ content: "release notes" });
    const client = connect({
      sampling: createMcpSamplingHandler({
        provider: () => provider,
        confirm: async () => true,
        onUsage: () => {},
      }),
    });
    try {
      const advertised = JSON.parse(await client.callTool("__getRoots", {})) as {
        capabilities: Record<string, unknown>;
      };
      expect(advertised.capabilities).toMatchObject({ sampling: {} });

      const answer = JSON.parse(await client.callTool("__sample", {})) as {
        result?: { content?: { text?: string }; model?: string };
      };
      expect(answer.result?.content?.text).toBe("release notes");
      expect(answer.result?.model).toBe("test-model");
      expect(calls[0]?.messages.at(-1)?.content).toBe("summarize this changelog");
    } finally {
      client.dispose();
    }
  });

  it("carries the user's answer back to a server that asked a question", async () => {
    const client = connect({
      elicitation: createMcpElicitationHandler({ askUser: async () => "Yes" }),
    });
    try {
      const answer = JSON.parse(await client.callTool("__elicit", {})) as {
        result?: { action?: string; content?: Record<string, unknown> };
      };
      expect(answer.result).toEqual({ action: "accept", content: { confirm: true } });
    } finally {
      client.dispose();
    }
  });

  it("answers a declining user without leaving the server waiting", async () => {
    const client = connect({
      elicitation: createMcpElicitationHandler({ askUser: async ({ options }) => options.at(-1)! }),
    });
    try {
      const answer = JSON.parse(await client.callTool("__elicit", {})) as { result?: { action?: string } };
      expect(answer.result).toEqual({ action: "decline" });
    } finally {
      client.dispose();
    }
  });
});

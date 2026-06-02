import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore, type AgentCoreDeps } from "../../src/agent/loop.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function captureProvider() {
  const seen: ChatMessage[][] = [];
  return {
    model: "flash",
    seen,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      seen.push(req.messages);
      return { content: "done", toolCalls: [], usage: USAGE, finishReason: "stop" };
    },
    chatStream(req: ChatRequest): Promise<ChatResponse> {
      return this.chat(req);
    },
  };
}

const noopDispatcher: ToolDispatcher = {
  list: () => [],
  execute: async (_c: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({ ok: true }),
};

async function drain(events: AsyncIterable<AgentEvent>): Promise<void> {
  for await (const _ of events) void _;
}

describe("memory injection gate (injectMemory)", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "seekforge-meminject-"));
    mkdirSync(join(ws, ".seekforge", "memory"), { recursive: true });
    writeFileSync(
      join(ws, ".seekforge", "memory", "project.md"),
      "# Project Memory\n- [convention] login validation lives in src/auth.ts\n",
      "utf8",
    );
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const task = "fix login validation in src/auth.ts";

  it("injects the project-memory brief into the system prompt by default", async () => {
    const provider = captureProvider();
    const deps: AgentCoreDeps = { provider, dispatcher: noopDispatcher, confirm: async () => true };
    await drain(createAgentCore(deps).runTask({ task, approvalMode: "auto", projectPath: ws, mode: "edit" }));
    const system = provider.seen[0]!.find((m) => m.role === "system")!;
    expect(system.content).toContain("Relevant project memory");
    expect(system.content).toContain("login validation lives in src/auth.ts");
  });

  it("omits memory entirely when injectMemory is false", async () => {
    const provider = captureProvider();
    const deps: AgentCoreDeps = {
      provider,
      dispatcher: noopDispatcher,
      confirm: async () => true,
      injectMemory: false,
    };
    await drain(createAgentCore(deps).runTask({ task, approvalMode: "auto", projectPath: ws, mode: "edit" }));
    const system = provider.seen[0]!.find((m) => m.role === "system")!;
    expect(system.content).not.toContain("Relevant project memory");
  });
});

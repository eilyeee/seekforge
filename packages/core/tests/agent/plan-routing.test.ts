import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore, type AgentCoreDeps } from "../../src/agent/loop.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(content: string): ChatResponse {
  return { content, toolCalls: [], usage: USAGE, finishReason: "stop" };
}

function fakeProvider(model: string): ChatProvider & { chats: number } {
  const p = {
    model,
    chats: 0,
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      p.chats++;
      return response(`answered by ${model}`);
    },
    chatStream(req: ChatRequest): Promise<ChatResponse> {
      return p.chat(req);
    },
  };
  return p;
}

const noopDispatcher: ToolDispatcher = {
  list: () => [],
  execute: async (_call: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({ ok: true }),
};

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("plan-model routing", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-planroute-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function makeDeps(): {
    deps: AgentCoreDeps;
    defaultProvider: ReturnType<typeof fakeProvider>;
    planProvider: ReturnType<typeof fakeProvider>;
    requestedModels: string[];
  } {
    const defaultProvider = fakeProvider("deepseek-v4-flash");
    const planProvider = fakeProvider("deepseek-v4-pro");
    const requestedModels: string[] = [];
    const deps: AgentCoreDeps = {
      provider: defaultProvider,
      dispatcher: noopDispatcher,
      confirm: async () => true,
      planModel: "deepseek-v4-pro",
      providerForModel: (model) => {
        requestedModels.push(model);
        return planProvider;
      },
    };
    return { deps, defaultProvider, planProvider, requestedModels };
  }

  const baseInput = { task: "make a plan", approvalMode: "auto" as const };

  it("routes plan:true runs through providerForModel(planModel)", async () => {
    const { deps, defaultProvider, planProvider, requestedModels } = makeDeps();
    const events = await collect(
      createAgentCore(deps).runTask({ ...baseInput, projectPath: workspace, mode: "ask", plan: true }),
    );
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
    expect(requestedModels).toEqual(["deepseek-v4-pro"]);
    expect(planProvider.chats).toBe(1);
    expect(defaultProvider.chats).toBe(0);
  });

  it("keeps the default provider when plan is false/unset", async () => {
    const { deps, defaultProvider, planProvider, requestedModels } = makeDeps();
    await collect(createAgentCore(deps).runTask({ ...baseInput, projectPath: workspace, mode: "edit" }));
    expect(requestedModels).toEqual([]);
    expect(defaultProvider.chats).toBe(1);
    expect(planProvider.chats).toBe(0);
  });

  it("keeps the default provider on plan:true when planModel is unset", async () => {
    const { deps, defaultProvider, planProvider, requestedModels } = makeDeps();
    delete deps.planModel;
    await collect(createAgentCore(deps).runTask({ ...baseInput, projectPath: workspace, mode: "ask", plan: true }));
    expect(requestedModels).toEqual([]);
    expect(defaultProvider.chats).toBe(1);
    expect(planProvider.chats).toBe(0);
  });

  it("falls back to the default provider when providerForModel is unset", async () => {
    const { deps, defaultProvider } = makeDeps();
    delete deps.providerForModel;
    await collect(createAgentCore(deps).runTask({ ...baseInput, projectPath: workspace, mode: "ask", plan: true }));
    expect(defaultProvider.chats).toBe(1);
  });
});

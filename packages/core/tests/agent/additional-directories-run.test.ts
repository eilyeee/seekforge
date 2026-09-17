import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { createDefaultDispatcher, type ToolContext, type ToolDispatcher } from "../../src/tools/index.js";
import { closeNetworkProxiesForTests } from "../../src/tools/network-proxy.js";

afterEach(() => closeNetworkProxiesForTests());

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

function scripted(script: ChatResponse[], requests: ChatRequest[]): ChatProvider {
  const next = async (req: ChatRequest) => {
    requests.push(req);
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", chat: next, chatStream: (req) => next(req) };
}

function capturing(): { dispatcher: ToolDispatcher; contexts: ToolContext[] } {
  const inner = createDefaultDispatcher();
  const contexts: ToolContext[] = [];
  return {
    contexts,
    dispatcher: {
      list: () => inner.list(),
      execute: (toolCall, ctx) => {
        contexts.push(ctx);
        return inner.execute(toolCall, ctx);
      },
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("additional directories in an agent run", () => {
  it("are validated per run, announced to the model, and usable by the file tools", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-run-ws-"));
    const extra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-run-extra-")));
    fs.writeFileSync(path.join(extra, "shared.txt"), "from the other repo\n");
    const requests: ChatRequest[] = [];
    const { dispatcher, contexts } = capturing();
    const agent = createAgentCore({
      provider: scripted(
        [
          response({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "c1",
                name: "read_file",
                argumentsJson: JSON.stringify({ path: path.join(extra, "shared.txt") }),
              },
            ],
          }),
          response({ content: "done" }),
        ],
        requests,
      ),
      dispatcher,
      confirm: async () => true,
      sandbox: "workspace-write",
      additionalDirectories: [extra, "/definitely/not/here"],
    });
    const events = await collect(
      agent.runTask({
        projectPath: ws,
        task: "read it",
        mode: "edit",
        approvalMode: "auto",
        appendSystemPrompt: "BE BRIEF",
      }),
    );

    const system = String(requests[0]?.messages[0]?.content ?? "");
    expect(system).toContain(`- ${extra}`);
    expect(system).toContain("BE BRIEF");
    expect(system.indexOf(extra)).toBeLessThan(system.indexOf("BE BRIEF"));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        level: "warn",
        message: expect.stringContaining("/definitely/not/here"),
      }),
    );
    const toolResult = events.find((e) => e.type === "tool.completed");
    expect(JSON.stringify(toolResult)).toContain("from the other repo");

    expect(contexts[0]?.additionalDirectories).toEqual([extra]);
    expect(contexts[0]?.sandbox).toEqual({ filesystem: "workspace-write", network: "inherit", writablePaths: [extra] });
  });

  it("leave a run without them exactly as before", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-run-ws-"));
    const requests: ChatRequest[] = [];
    const { dispatcher, contexts } = capturing();
    const agent = createAgentCore({
      provider: scripted(
        [
          response({
            finishReason: "tool_calls",
            toolCalls: [{ id: "c1", name: "list_files", argumentsJson: "{}" }],
          }),
          response({ content: "done" }),
        ],
        requests,
      ),
      dispatcher,
      confirm: async () => true,
      sandbox: "restricted",
    });
    const events = await collect(agent.runTask({ projectPath: ws, task: "list", mode: "edit", approvalMode: "auto" }));
    expect(events.some((e) => e.type === "notice" && e.level === "warn")).toBe(false);
    expect(String(requests[0]?.messages[0]?.content)).not.toContain("granted the file tools access");
    expect(contexts[0]?.sandbox).toBe("restricted");
    expect(contexts[0]).not.toHaveProperty("additionalDirectories");
  });

  it("start the allowlist proxy before any tool runs", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-run-ws-"));
    const { dispatcher, contexts } = capturing();
    const agent = createAgentCore({
      provider: scripted(
        [
          response({ finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "list_files", argumentsJson: "{}" }] }),
          response({ content: "done" }),
        ],
        [],
      ),
      dispatcher,
      confirm: async () => true,
      sandbox: { filesystem: "workspace-write", network: { allowedDomains: ["registry.npmjs.org"] } },
    });
    await collect(agent.runTask({ projectPath: ws, task: "list", mode: "edit", approvalMode: "auto" }));
    const sandbox = contexts[0]?.sandbox;
    expect(typeof sandbox).toBe("object");
    const network = (sandbox as { network: { proxy?: { port: number } } }).network;
    expect(network.proxy?.port).toBeGreaterThan(0);
  });
});

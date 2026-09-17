import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse } from "@seekforge/shared";
import type { ChatProvider } from "../../src/provider/index.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { readSessionMeta } from "../../src/agent/trace.js";
import { call, makeCtx } from "../tools/helpers.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

function fakeProvider(script: ChatResponse[]): ChatProvider {
  const next = async () => {
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", chat: next, chatStream: () => next() };
}

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "seekforge-active-form-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeMeta(id: string, plan: unknown): void {
  const dir = join(workspace, ".seekforge", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, "session.json"),
    JSON.stringify({ id, task: "t", mode: "edit", status: "completed", createdAt: now, updatedAt: now, plan }),
  );
}

describe("update_plan activeForm", () => {
  const dispatcher = createDefaultDispatcher();

  it("accepts an optional activeForm and returns it", async () => {
    const items = [
      { step: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
      { step: "Report", status: "pending" },
    ];
    const res = await dispatcher.execute(call("update_plan", { items }), makeCtx(workspace));
    expect(res).toMatchObject({ ok: true, data: { items } });
  });

  it("rejects an empty or non-string activeForm", async () => {
    for (const activeForm of ["", 42]) {
      const res = await dispatcher.execute(
        call("update_plan", { items: [{ step: "a", status: "pending", activeForm }] }),
        makeCtx(workspace),
      );
      expect(res.error?.code).toBe("invalid_args");
    }
  });

  it("persists it in the session meta", async () => {
    const items = [{ step: "Run the tests", status: "in_progress", activeForm: "Running the tests" }];
    const agent = createAgentCore({
      provider: fakeProvider([
        response({
          toolCalls: [{ id: "p1", name: "update_plan", argumentsJson: JSON.stringify({ items }) }],
          finishReason: "tool_calls",
        }),
        response({ content: "done" }),
        response({ content: "done, the tests are still running elsewhere" }),
      ]),
      dispatcher,
      confirm: async () => true,
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.runTask({
      projectPath: workspace,
      task: "t",
      mode: "edit",
      approvalMode: "auto",
      systemPromptOverride: "sys",
    })) {
      events.push(event);
    }
    const sessionId = (events[0] as { sessionId: string }).sessionId;
    expect(readSessionMeta(workspace, sessionId)?.plan).toEqual(items);
  });

  it("still loads sessions written before it existed, and refuses a malformed one", () => {
    writeMeta("legacy", [{ step: "a", status: "done" }]);
    expect(readSessionMeta(workspace, "legacy")?.plan).toEqual([{ step: "a", status: "done" }]);
    writeMeta("bad", [{ step: "a", status: "done", activeForm: 7 }]);
    expect(readSessionMeta(workspace, "bad")).toBeUndefined();
  });
});

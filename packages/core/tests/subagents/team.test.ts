import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import { createDispatchManager } from "../../src/subagents/manager.js";
import { validateAgentTeam } from "../../src/subagents/team.js";
import type { AgentDefinition } from "../../src/subagents/types.js";
import {
  collect,
  deferred,
  fakeDispatcher,
  isParentRequest,
  response,
  routedProvider,
  toolCall,
  toolCallsResponse,
  toolCompleted,
} from "./helpers.js";

const agents: AgentDefinition[] = ["reviewer", "tester"].map((id) => ({
  id,
  name: id,
  description: id,
  triggers: [],
  mode: "ask",
  scope: "builtin",
}));

const fixer: AgentDefinition = {
  id: "fixer",
  name: "fixer",
  description: "fixer",
  triggers: [],
  mode: "edit",
  scope: "builtin",
};

describe("validateAgentTeam", () => {
  it("normalizes a valid dependency graph and defaults", () => {
    const result = validateAgentTeam(
      {
        members: [
          { id: "review", agentId: "reviewer", task: "Review the change" },
          { id: "verify", agentId: "tester", task: "Run focused tests", dependsOn: ["review", "review"] },
        ],
      },
      agents,
    );
    expect(result).toEqual({
      ok: true,
      plan: {
        members: [
          { id: "review", agentId: "reviewer", task: "Review the change", dependsOn: [] },
          { id: "verify", agentId: "tester", task: "Run focused tests", dependsOn: ["review"] },
        ],
        maxConcurrency: 2,
        failurePolicy: "stop",
      },
    });
  });

  it("rejects duplicate ids, unknown agents, and missing dependencies", () => {
    expect(
      validateAgentTeam(
        {
          members: [
            { id: "a", agentId: "reviewer", task: "one" },
            { id: "a", agentId: "tester", task: "two" },
          ],
        },
        agents,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("duplicate") });
    expect(validateAgentTeam({ members: [{ id: "a", agentId: "missing", task: "one" }] }, agents)).toMatchObject({
      ok: false,
      message: expect.stringContaining("unknown agent"),
    });
    expect(
      validateAgentTeam({ members: [{ id: "a", agentId: "reviewer", task: "one", dependsOn: ["missing"] }] }, agents),
    ).toMatchObject({ ok: false, message: expect.stringContaining("unknown member") });
  });

  it("rejects cycles before any execution can begin", () => {
    expect(
      validateAgentTeam(
        {
          members: [
            { id: "a", agentId: "reviewer", task: "one", dependsOn: ["b"] },
            { id: "b", agentId: "tester", task: "two", dependsOn: ["a"] },
          ],
        },
        agents,
      ),
    ).toEqual({ ok: false, message: "team dependencies contain a cycle" });
  });

  it("bounds concurrency and validates failure policy", () => {
    const members = [{ id: "a", agentId: "reviewer", task: "one" }];
    expect(validateAgentTeam({ members, maxConcurrency: 0 }, agents)).toMatchObject({ ok: false });
    expect(validateAgentTeam({ members, failurePolicy: "ignore" }, agents)).toMatchObject({ ok: false });
  });

  it("executes ready members before their dependants through the normal dispatch lifecycle", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-team-"));
    const started: string[] = [];
    let parentTurns = 0;
    const provider = routedProvider((request) => {
      if (isParentRequest(request)) {
        parentTurns++;
        return parentTurns === 1
          ? toolCallsResponse(
              toolCall("team-1", "dispatch_team", {
                members: [
                  { id: "review", agentId: "reviewer", task: "review first" },
                  { id: "test", agentId: "tester", task: "test first" },
                  { id: "synthesize", agentId: "reviewer", task: "synthesize", dependsOn: ["review", "test"] },
                ],
                maxConcurrency: 2,
              }),
            )
          : response({ content: "done" });
      }
      const agentId = request.messages[0]!.content.includes("You are reviewer") ? "reviewer" : "tester";
      started.push(agentId);
      return response({ content: `${agentId} report` });
    });

    try {
      const events = await collect(
        createAgentCore({
          provider,
          dispatcher: fakeDispatcher(),
          confirm: async () => true,
          subagents: agents,
        }).runTask({ task: "coordinate", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
      );

      expect(started).toEqual(["reviewer", "tester", "reviewer"]);
      const [completed] = toolCompleted(events, "dispatch_team");
      expect(completed!.result).toMatchObject({
        ok: true,
        data: {
          status: "done",
          members: [
            { id: "review", status: "done" },
            { id: "test", status: "done" },
            { id: "synthesize", status: "done" },
          ],
        },
      });
      expect(events.filter((event) => event.type === "subagent.started")).toHaveLength(3);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("stops pending members after a denied edit member when failurePolicy is stop", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-team-stop-"));
    let parentTurns = 0;
    const provider = routedProvider((request) => {
      if (!isParentRequest(request)) throw new Error("a denied team member must not start");
      parentTurns++;
      return parentTurns === 1
        ? toolCallsResponse(
            toolCall("team-1", "dispatch_team", {
              members: [
                { id: "fix", agentId: "fixer", task: "edit files" },
                { id: "review", agentId: "reviewer", task: "review independently" },
              ],
              maxConcurrency: 1,
              failurePolicy: "stop",
            }),
          )
        : response({ content: "done" });
    });

    try {
      const events = await collect(
        createAgentCore({
          provider,
          dispatcher: fakeDispatcher(),
          confirm: async () => false,
          subagents: [...agents, fixer],
        }).runTask({ task: "coordinate", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
      );

      const [completed] = toolCompleted(events, "dispatch_team");
      expect(completed!.result).toMatchObject({
        ok: false,
        error: { code: "team_failed" },
        data: {
          members: [
            { id: "fix", status: "failed", result: { error: { code: "denied_by_user" } } },
            { id: "review", status: "skipped", reason: "team stopped after a member failure" },
          ],
        },
      });
      expect(events.some((event) => event.type === "subagent.started")).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("serializes edit-member confirmations before launching approved work concurrently", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-team-confirm-"));
    let parentTurns = 0;
    let confirming = 0;
    let maxConfirming = 0;
    const provider = routedProvider((request) => {
      if (isParentRequest(request)) {
        parentTurns++;
        return parentTurns === 1
          ? toolCallsResponse(
              toolCall("team-1", "dispatch_team", {
                members: [
                  { id: "fix-a", agentId: "fixer", task: "edit a" },
                  { id: "fix-b", agentId: "fixer", task: "edit b" },
                ],
                maxConcurrency: 2,
              }),
            )
          : response({ content: "done" });
      }
      return request.messages.some((message) => message.role === "tool")
        ? response({ content: "fixed" })
        : toolCallsResponse(toolCall("write-1", "write_file", { path: "x.ts", content: "x" }));
    });

    try {
      const events = await collect(
        createAgentCore({
          provider,
          dispatcher: fakeDispatcher(),
          confirm: async () => {
            confirming++;
            maxConfirming = Math.max(maxConfirming, confirming);
            await Promise.resolve();
            confirming--;
            return true;
          },
          subagents: [fixer],
        }).runTask({ task: "coordinate", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
      );

      expect(maxConfirming).toBe(1);
      expect(confirming).toBe(0);
      expect(toolCompleted(events, "dispatch_team")[0]!.result.ok).toBe(true);
      expect(events.filter((event) => event.type === "subagent.started")).toHaveLength(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("serializes edit members while read-only members keep running concurrently", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-team-edit-serial-"));
    const releaseFirstEdit = deferred<void>();
    let parentTurns = 0;
    let activeEdits = 0;
    let maxActiveEdits = 0;
    let readOnlyOverlappedEdit = false;
    const provider = routedProvider(async (request) => {
      if (isParentRequest(request)) {
        parentTurns++;
        return parentTurns === 1
          ? toolCallsResponse(
              toolCall("team-1", "dispatch_team", {
                members: [
                  { id: "edit-a", agentId: "fixer", task: "edit first" },
                  { id: "edit-b", agentId: "fixer", task: "edit second" },
                  { id: "review", agentId: "reviewer", task: "review concurrently" },
                ],
                maxConcurrency: 3,
              }),
            )
          : response({ content: "done" });
      }
      const task = request.messages.find((message) => message.role === "user")?.content ?? "";
      if (task.includes("review concurrently")) {
        readOnlyOverlappedEdit = activeEdits === 1;
        releaseFirstEdit.resolve();
        return response({ content: "reviewed" });
      }
      activeEdits++;
      maxActiveEdits = Math.max(maxActiveEdits, activeEdits);
      if (task.includes("edit first")) await releaseFirstEdit.promise;
      activeEdits--;
      return response({ content: "edited" });
    });

    try {
      const events = await collect(
        createAgentCore({
          provider,
          dispatcher: fakeDispatcher(),
          confirm: async () => true,
          subagents: [...agents, fixer],
        }).runTask({ task: "coordinate", mode: "edit", approvalMode: "auto", projectPath: workspace }),
      );

      expect(readOnlyOverlappedEdit).toBe(true);
      expect(maxActiveEdits).toBe(1);
      expect(toolCompleted(events, "dispatch_team")[0]!.result.ok).toBe(true);
    } finally {
      releaseFirstEdit.resolve();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fills a free concurrency slot as soon as a dependency branch becomes ready", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-team-ready-"));
    const slowGate = deferred<void>();
    let parentTurns = 0;
    let synthesisStarted = false;
    const provider = routedProvider(async (request) => {
      if (isParentRequest(request)) {
        parentTurns++;
        return parentTurns === 1
          ? toolCallsResponse(
              toolCall("team-1", "dispatch_team", {
                members: [
                  { id: "slow", agentId: "reviewer", task: "slow branch" },
                  { id: "fast", agentId: "tester", task: "fast branch" },
                  { id: "synthesis", agentId: "tester", task: "synthesize fast", dependsOn: ["fast"] },
                ],
                maxConcurrency: 2,
              }),
            )
          : response({ content: "done" });
      }
      const userText = request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      if (userText.includes("slow branch")) {
        await slowGate.promise;
        return response({ content: "slow done" });
      }
      if (userText.includes("synthesize fast")) {
        synthesisStarted = true;
        slowGate.resolve();
        return response({ content: "synthesis done" });
      }
      return response({ content: "fast done" });
    });

    try {
      const events = await collect(
        createAgentCore({
          provider,
          dispatcher: fakeDispatcher(),
          confirm: async () => true,
          subagents: agents,
        }).runTask({ task: "coordinate", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
      );

      expect(synthesisStarted).toBe(true);
      expect(toolCompleted(events, "dispatch_team")[0]!.result.ok).toBe(true);
    } finally {
      slowGate.resolve();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves an explicitly cancelled member as team_cancelled", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-team-cancel-"));
    const nestedGate = deferred<void>();
    const manager = createDispatchManager();
    let parentTurns = 0;
    const provider = routedProvider(async (request) => {
      if (isParentRequest(request)) {
        parentTurns++;
        return parentTurns === 1
          ? toolCallsResponse(
              toolCall("team-1", "dispatch_team", {
                members: [{ id: "review", agentId: "reviewer", task: "wait for cancellation" }],
              }),
            )
          : response({ content: "done" });
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(request.signal?.reason ?? new Error("cancelled"));
        if (request.signal?.aborted) {
          onAbort();
          return;
        }
        request.signal?.addEventListener("abort", onAbort, { once: true });
        void nestedGate.promise.then(() => {
          request.signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      return response({ content: "too late" });
    });

    try {
      const events = [];
      const stream = createAgentCore({
        provider,
        dispatcher: fakeDispatcher(),
        confirm: async () => true,
        subagents: agents,
        dispatchManager: manager,
        hooks: { subagentStop: [{ command: "echo called >> stop-count; cat > stop-payload.json" }] },
      }).runTask({ task: "coordinate", mode: "edit", approvalMode: "confirm", projectPath: workspace });
      for await (const event of stream) {
        events.push(event);
        if (event.type === "subagent.started") manager.cancel(event.dispatchId);
      }

      expect(toolCompleted(events, "dispatch_team")[0]!.result).toMatchObject({
        ok: false,
        error: { code: "team_cancelled" },
        data: { status: "cancelled", members: [{ id: "review", status: "cancelled" }] },
      });
      expect(events.some((event) => event.type === "subagent.cancelled")).toBe(true);
      expect(readFileSync(join(workspace, "stop-count"), "utf8").trim().split("\n")).toEqual(["called"]);
      expect(JSON.parse(readFileSync(join(workspace, "stop-payload.json"), "utf8"))).toMatchObject({
        stage: "subagentStop",
        agentId: "reviewer",
        ok: false,
      });
    } finally {
      nestedGate.resolve();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

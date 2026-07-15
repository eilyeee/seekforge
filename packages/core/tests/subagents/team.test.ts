import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import { validateAgentTeam } from "../../src/subagents/team.js";
import type { AgentDefinition } from "../../src/subagents/types.js";
import {
  collect,
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
    const result = validateAgentTeam({
      members: [
        { id: "review", agentId: "reviewer", task: "Review the change" },
        { id: "verify", agentId: "tester", task: "Run focused tests", dependsOn: ["review", "review"] },
      ],
    }, agents);
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
    expect(validateAgentTeam({ members: [
      { id: "a", agentId: "reviewer", task: "one" },
      { id: "a", agentId: "tester", task: "two" },
    ] }, agents)).toMatchObject({ ok: false, message: expect.stringContaining("duplicate") });
    expect(validateAgentTeam({ members: [
      { id: "a", agentId: "missing", task: "one" },
    ] }, agents)).toMatchObject({ ok: false, message: expect.stringContaining("unknown agent") });
    expect(validateAgentTeam({ members: [
      { id: "a", agentId: "reviewer", task: "one", dependsOn: ["missing"] },
    ] }, agents)).toMatchObject({ ok: false, message: expect.stringContaining("unknown member") });
  });

  it("rejects cycles before any execution can begin", () => {
    expect(validateAgentTeam({ members: [
      { id: "a", agentId: "reviewer", task: "one", dependsOn: ["b"] },
      { id: "b", agentId: "tester", task: "two", dependsOn: ["a"] },
    ] }, agents)).toEqual({ ok: false, message: "team dependencies contain a cycle" });
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
          ? toolCallsResponse(toolCall("team-1", "dispatch_team", {
              members: [
                { id: "review", agentId: "reviewer", task: "review first" },
                { id: "test", agentId: "tester", task: "test first" },
                { id: "synthesize", agentId: "reviewer", task: "synthesize", dependsOn: ["review", "test"] },
              ],
              maxConcurrency: 2,
            }))
          : response({ content: "done" });
      }
      const agentId = request.messages[0]!.content.includes("You are reviewer") ? "reviewer" : "tester";
      started.push(agentId);
      return response({ content: `${agentId} report` });
    });

    try {
      const events = await collect(createAgentCore({
        provider,
        dispatcher: fakeDispatcher(),
        confirm: async () => true,
        subagents: agents,
      }).runTask({ task: "coordinate", mode: "edit", approvalMode: "confirm", projectPath: workspace }));

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
        ? toolCallsResponse(toolCall("team-1", "dispatch_team", {
            members: [
              { id: "fix", agentId: "fixer", task: "edit files" },
              { id: "review", agentId: "reviewer", task: "review independently" },
            ],
            maxConcurrency: 1,
            failurePolicy: "stop",
          }))
        : response({ content: "done" });
    });

    try {
      const events = await collect(createAgentCore({
        provider,
        dispatcher: fakeDispatcher(),
        confirm: async () => false,
        subagents: [...agents, fixer],
      }).runTask({ task: "coordinate", mode: "edit", approvalMode: "confirm", projectPath: workspace }));

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
});

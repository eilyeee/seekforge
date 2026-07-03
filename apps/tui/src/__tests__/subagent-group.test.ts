import { describe, expect, it } from "vitest";
import type { ChatItem } from "../model.js";
import { groupSubagentSteps } from "../subagent-group.js";

function step(id: string, title: string, agentId?: string): ChatItem {
  return agentId ? { kind: "step", id, title, agentId } : { kind: "step", id, title };
}

describe("groupSubagentSteps", () => {
  it("returns nothing for an empty list", () => {
    expect(groupSubagentSteps([])).toEqual([]);
  });

  it("collapses consecutive steps of one agent into a single group", () => {
    const nodes = groupSubagentSteps([
      step("s1", "search_text", "agent-a"),
      step("s2", "read_file", "agent-a"),
      step("s3", "write_file", "agent-a"),
    ]);
    expect(nodes).toEqual([
      {
        kind: "subagent-group",
        id: "s1",
        agentId: "agent-a",
        steps: [
          { id: "s1", title: "search_text" },
          { id: "s2", title: "read_file" },
          { id: "s3", title: "write_file" },
        ],
      },
    ]);
  });

  it("starts a new group when the agentId changes and interleaves back", () => {
    const nodes = groupSubagentSteps([
      step("s1", "a1", "agent-a"),
      step("s2", "b1", "agent-b"),
      step("s3", "a2", "agent-a"),
    ]);
    expect(nodes.map((n) => (n.kind === "subagent-group" ? n.agentId : "item"))).toEqual([
      "agent-a",
      "agent-b",
      "agent-a",
    ]);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ agentId: "agent-a", steps: [{ id: "s1", title: "a1" }] });
    expect(nodes[2]).toMatchObject({ agentId: "agent-a", steps: [{ id: "s3", title: "a2" }] });
  });

  it("passes non-subagent steps and other items through untouched", () => {
    const assistant: ChatItem = { kind: "assistant", id: "m1", text: "hi", streaming: false };
    const plainStep = step("s1", "just a step");
    const nodes = groupSubagentSteps([assistant, plainStep]);
    expect(nodes).toEqual([
      { kind: "item", item: assistant },
      { kind: "item", item: plainStep },
    ]);
  });

  it("does not merge same-agent steps split by an intervening item", () => {
    const assistant: ChatItem = { kind: "assistant", id: "m1", text: "note", streaming: false };
    const nodes = groupSubagentSteps([
      step("s1", "a1", "agent-a"),
      assistant,
      step("s2", "a2", "agent-a"),
    ]);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ kind: "subagent-group", steps: [{ id: "s1" }] });
    expect(nodes[1]).toEqual({ kind: "item", item: assistant });
    expect(nodes[2]).toMatchObject({ kind: "subagent-group", steps: [{ id: "s2" }] });
  });
});

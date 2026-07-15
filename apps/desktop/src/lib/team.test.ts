import { describe, expect, it } from "vitest";
import { teamLayers, teamPlanTask, validateTeamPlan } from "./team";

describe("team plans", () => {
  const agents = new Set(["explorer", "reviewer"]);

  it("normalizes a valid DAG and preserves it in the submitted task", () => {
    const result = validateTeamPlan({
      members: [
        { id: "inspect", agentId: "explorer", task: "inspect", dependsOn: [] },
        { id: "review", agentId: "reviewer", task: "review", dependsOn: ["inspect", "inspect"] },
      ],
      maxConcurrency: 2,
      failurePolicy: "continue",
    }, agents);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.members[1]!.dependsOn).toEqual(["inspect"]);
    expect(teamLayers(result.plan.members).map((layer) => layer.map((member) => member.id))).toEqual([["inspect"], ["review"]]);
    expect(teamPlanTask(result.plan)).toContain('"failurePolicy": "continue"');
  });

  it("rejects unknown dependencies and cycles before submission", () => {
    expect(validateTeamPlan({ members: [{ id: "a", agentId: "explorer", task: "x", dependsOn: ["missing"] }] }, agents)).toMatchObject({ ok: false });
    expect(validateTeamPlan({ members: [
      { id: "a", agentId: "explorer", task: "x", dependsOn: ["b"] },
      { id: "b", agentId: "reviewer", task: "y", dependsOn: ["a"] },
    ] }, agents)).toEqual({ ok: false, error: "team dependencies contain a cycle" });
  });
});

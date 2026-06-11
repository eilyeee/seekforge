import { describe, expect, it } from "vitest";
import { buildSubagentPrompt } from "../../src/subagents/prompt.js";
import type { AgentDefinition } from "../../src/subagents/types.js";

const base: AgentDefinition = {
  id: "reviewer",
  name: "Reviewer",
  description: "reviews diffs",
  triggers: [],
  mode: "ask",
  scope: "project",
};

describe("buildSubagentPrompt", () => {
  it("includes identity, workspace, mode rules and the report instruction", () => {
    const p = buildSubagentPrompt(base, "/ws");
    expect(p).toContain("You are Reviewer (reviewer)");
    expect(p).toContain("/ws");
    expect(p).toContain("Specialty: reviews diffs");
    expect(p).toContain("ASK (read-only)");
    expect(p).toContain("never attempt writes");
    expect(p).toContain("markdown report");
  });

  it("renders own/boundary/do-not-touch as binding constraints and appends the body", () => {
    const p = buildSubagentPrompt(
      {
        ...base,
        mode: "edit",
        own: "review verdicts",
        boundary: "not an executor",
        doNotTouch: "CI config",
        body: "# Procedure\n1. read",
      },
      "/ws",
    );
    expect(p).toContain("Binding constraints");
    expect(p).toContain("- You own: review verdicts");
    expect(p).toContain("- Boundary: not an executor");
    expect(p).toContain("- Do not touch: CI config");
    expect(p).toContain("Mode: EDIT");
    expect(p.endsWith("# Procedure\n1. read")).toBe(true);
  });
});

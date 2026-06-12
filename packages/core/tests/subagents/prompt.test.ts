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

  it("frames the report for the parent agent: lead with the answer, bounded length", () => {
    const p = buildSubagentPrompt(base, "/ws");
    expect(p).toContain("parent SeekForge agent");
    expect(p).toContain("a machine, not a human");
    expect(p).toContain("Lead with the answer");
    expect(p).toContain("~400 words");
    expect(p).toContain("The parent only sees this final report");
  });

  it("states the turn budget (default and per-definition) and the no-questions rule", () => {
    expect(buildSubagentPrompt(base, "/ws")).toContain("at most 15 turns");
    expect(buildSubagentPrompt({ ...base, maxTurns: 5 }, "/ws")).toContain("at most 5 turns");
    const p = buildSubagentPrompt(base, "/ws");
    expect(p).toContain("You cannot ask questions");
    expect(p).toContain("ask_user is unavailable in nested runs");
    expect(p).toContain("state your assumption");
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

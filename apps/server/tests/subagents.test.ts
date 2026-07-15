import { describe, expect, it } from "vitest";
import { buildAgentDeps } from "../src/agent.js";
import { makeWorkspace, writeFileIn } from "./helpers.js";

describe("server subagent assembly", () => {
  it("loads workspace agent definitions into normal WS agent deps", () => {
    const workspace = makeWorkspace();
    writeFileIn(
      workspace,
      ".seekforge/agents/custom-reviewer/AGENT.md",
      "---\nname: custom-reviewer\ndescription: project reviewer\nmode: ask\n---\nReview the requested files.",
    );

    const deps = buildAgentDeps({
      workspace,
      confirm: async () => false,
      extractMemory: false,
    });

    expect(deps.subagents?.some((agent) => agent.id === "custom-reviewer")).toBe(true);
    deps.runtime?.dispose();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { buildAgentDeps } from "../src/agent.js";
import { makeWorkspace, writeFileIn } from "./helpers.js";

const savedHome = process.env["SEEKFORGE_HOME"];
afterEach(() => {
  if (savedHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = savedHome;
});

function depsWith(global: Record<string, unknown>, project: Record<string, unknown>) {
  const home = makeWorkspace();
  const workspace = makeWorkspace();
  writeFileIn(home, ".seekforge/config.json", JSON.stringify({ apiKey: "sk-test", ...global }));
  writeFileIn(workspace, ".seekforge/config.json", JSON.stringify(project));
  process.env["SEEKFORGE_HOME"] = home;
  const deps = buildAgentDeps({ workspace, confirm: async () => false, extractMemory: false });
  deps.runtime?.dispose();
  return deps;
}

describe("server context-window settings", () => {
  const settings = { autoCompactThreshold: 0.75, modelContextWindows: { "local-model": 32_768 } };

  it("reach the agent from the user's own config", () => {
    expect(depsWith(settings, {})).toMatchObject(settings);
  });

  it("are ignored in a repository's config", () => {
    const deps = depsWith({}, settings);
    expect(deps.autoCompactThreshold).toBeUndefined();
    expect(deps.modelContextWindows).toBeUndefined();
  });
});

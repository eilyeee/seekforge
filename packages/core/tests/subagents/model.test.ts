import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import { parseAgentMarkdown } from "../../src/subagents/load.js";
import { parseExternalAgent, renderAgentMarkdown } from "../../src/subagents/import.js";
import type { AgentDefinition } from "../../src/subagents/index.js";
import {
  collect,
  fakeDispatcher,
  fakeProvider,
  response,
  toolCall,
  toolCallsResponse,
  toolCompleted,
} from "./helpers.js";

const specialist: AgentDefinition = {
  id: "specialist",
  name: "Specialist",
  description: "model-pinned agent",
  triggers: [],
  mode: "ask",
  scope: "project",
  model: "deepseek-coder",
};

describe("per-agent model", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-model-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do the thing", mode: "edit" as const, approvalMode: "confirm" as const };

  it("routes a dispatch through providerForModel when the def has a model", async () => {
    const parentProvider = fakeProvider([
      toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: "specialist", task: "go" })),
      response({ content: "done" }),
    ]);
    const nestedProvider = fakeProvider([response({ content: "model report" })]);
    const requestedModels: string[] = [];

    const agent = createAgentCore({
      provider: parentProvider,
      providerForModel: (model) => {
        requestedModels.push(model);
        return nestedProvider;
      },
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [specialist],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    expect(requestedModels).toEqual(["deepseek-coder"]);
    expect(nestedProvider.requests).toHaveLength(1);
    expect(nestedProvider.requests[0]!.messages[0]!.content).toContain("You are Specialist");
    expect(parentProvider.requests).toHaveLength(2); // nested run never hit the parent provider
    const [done] = toolCompleted(events, "dispatch_agent");
    expect((done!.result.data as { report: string }).report).toBe("model report");
  });

  it("uses the default provider when the def has no model", async () => {
    const provider = fakeProvider([
      toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: "plain", task: "go" })),
      response({ content: "plain report" }), // nested run, same provider
      response({ content: "done" }),
    ]);
    const requestedModels: string[] = [];
    const plain: AgentDefinition = { ...specialist, id: "plain", name: "Plain" };
    delete (plain as { model?: string }).model;

    const agent = createAgentCore({
      provider,
      providerForModel: (model) => {
        requestedModels.push(model);
        return provider;
      },
      dispatcher: fakeDispatcher(),
      confirm: async () => true,
      subagents: [plain],
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(requestedModels).toEqual([]);
    expect(provider.requests).toHaveLength(3);
    const [done] = toolCompleted(events, "dispatch_agent");
    expect((done!.result.data as { report: string }).report).toBe("plain report");
  });
});

describe("model frontmatter", () => {
  it("parseAgentMarkdown reads the model key", () => {
    const def = parseAgentMarkdown(
      "project",
      "pinned",
      "---\nname: pinned\ndescription: d\nmodel: deepseek-coder\n---\nbody",
    );
    expect(def.model).toBe("deepseek-coder");
    const plain = parseAgentMarkdown("project", "plain", "---\nname: plain\ndescription: d\n---\n");
    expect(plain.model).toBeUndefined();
  });

  it("renderAgentMarkdown round-trips the model key", () => {
    const md = renderAgentMarkdown({
      id: "pinned",
      name: "pinned",
      description: "d",
      triggers: [],
      mode: "ask",
      model: "deepseek-coder",
    });
    expect(md).toContain('model: "deepseek-coder"');
    expect(parseAgentMarkdown("project", "pinned", md).model).toBe("deepseek-coder");
  });

  it("parseExternalAgent imports the model key", () => {
    const { def } = parseExternalAgent("---\nname: Ext Agent\ndescription: d\nmodel: deepseek-coder\n---\nbody");
    expect(def.model).toBe("deepseek-coder");
  });
});

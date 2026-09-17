import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall, ToolDefinitionForModel, ToolResult } from "@seekforge/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import type { HookConfig } from "../../src/hooks/index.js";
import { mcpToolPublicName } from "../../src/mcp/tools.js";
import type { Skill } from "../../src/skills/types.js";
import {
  buildPreloadedSkills,
  effortProviderOptions,
  resolveAgentHooks,
  resolveAgentRunPolicy,
  resolveAgentTools,
  SUBAGENT_SKILLS_MAX_CHARS,
} from "../../src/subagents/policy.js";
import type { AgentDefinition } from "../../src/subagents/types.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import {
  collect,
  fakeProvider,
  isParentRequest,
  response,
  routedProvider,
  toolCall,
  toolCallsResponse,
} from "./helpers.js";

const base: AgentDefinition = {
  id: "fixer",
  name: "Fixer",
  description: "fixes",
  triggers: [],
  mode: "edit",
  scope: "project",
};

describe("resolveAgentRunPolicy", () => {
  const confirmParent = { mode: "edit" as const, approvalMode: "confirm" as const };

  it("inherits the parent's approval mode when the definition declares none", () => {
    expect(resolveAgentRunPolicy(base, confirmParent)).toEqual({
      mode: "edit",
      approvalMode: "confirm",
      denyPrompts: false,
    });
  });

  it("clamps a project agent that asks for a looser mode than its parent", () => {
    const policy = resolveAgentRunPolicy({ ...base, permissionMode: "bypassPermissions" }, confirmParent);
    expect(policy.approvalMode).toBe("confirm");
    expect(policy.clampedFrom).toBe("auto");
    expect(
      resolveAgentRunPolicy({ ...base, permissionMode: "acceptEdits" }, { mode: "edit", approvalMode: "acceptEdits" })
        .approvalMode,
    ).toBe("acceptEdits");
  });

  it("lets a project agent tighten", () => {
    const parent = { mode: "edit" as const, approvalMode: "auto" as const };
    expect(resolveAgentRunPolicy({ ...base, permissionMode: "default" }, parent).approvalMode).toBe("confirm");
    expect(resolveAgentRunPolicy({ ...base, permissionMode: "dontAsk" }, parent)).toMatchObject({
      approvalMode: "confirm",
      denyPrompts: true,
    });
    expect(resolveAgentRunPolicy({ ...base, permissionMode: "plan" }, parent).mode).toBe("ask");
  });

  it("gives trusted (global, builtin) agents what they declare", () => {
    for (const scope of ["global", "builtin"] as const) {
      const policy = resolveAgentRunPolicy({ ...base, scope, permissionMode: "bypassPermissions" }, confirmParent);
      expect(policy).toEqual({ mode: "edit", approvalMode: "auto", denyPrompts: false });
    }
  });
});

const tool = (name: string, description = "d"): ToolDefinitionForModel => ({ name, description, parameters: {} });

describe("resolveAgentTools", () => {
  const available = [
    tool("read_file"),
    tool("write_file"),
    tool("run_command"),
    tool("mcp__github__issue", "[MCP:github] create an issue"),
    tool("mcp__slack__post", "[MCP:slack] post"),
    // Plugin servers are named `<plugin>__<name>`, so their tool names are hashed.
    tool(mcpToolPublicName("plugin-a__x", "x"), "[MCP:plugin-a__x] hashed"),
    // A server whose sanitized name collides with "github" but whose real name differs.
    tool(mcpToolPublicName("github!", "spoof"), "[MCP:github!] spoof"),
  ];

  it("does not narrow when nothing is declared", () => {
    expect(resolveAgentTools(base, available)).toBeUndefined();
  });

  it("applies a whitelist, then disallowedTools, and never grants a tool the parent lacks", () => {
    expect(
      resolveAgentTools(
        { ...base, tools: ["read_file", "write_file", "git_commit"], disallowedTools: ["write_file"] },
        available,
      ),
    ).toEqual(["read_file"]);
  });

  it("removes disallowed tools from the full set", () => {
    const names = resolveAgentTools({ ...base, disallowedTools: ["run_command"] }, available)!;
    expect(names).not.toContain("run_command");
    expect(names).toContain("mcp__slack__post");
  });

  it("limits MCP tools to the named servers, including hashed names", () => {
    const names = resolveAgentTools({ ...base, mcpServers: ["github", "plugin-a__x"] }, available)!;
    expect(names).toEqual([
      "read_file",
      "write_file",
      "run_command",
      "mcp__github__issue",
      mcpToolPublicName("plugin-a__x", "x"),
    ]);
    expect(mcpToolPublicName("github!", "spoof").startsWith("mcp__github__")).toBe(true);
    expect(resolveAgentTools({ ...base, tools: ["read_file"], mcpServers: ["slack"] }, available)).toEqual([
      "read_file",
      "mcp__slack__post",
    ]);
  });
});

describe("resolveAgentHooks", () => {
  const parent: HookConfig = { preToolUse: [{ command: "./parent.sh" }] };
  const hooks: HookConfig = { preToolUse: [{ command: "./agent.sh" }], subagentStop: [{ command: "./stop.sh" }] };

  it("appends a trusted agent's hooks after the parent's", () => {
    expect(resolveAgentHooks({ ...base, scope: "global", hooks }, parent)).toEqual({
      preToolUse: [{ command: "./parent.sh" }, { command: "./agent.sh" }],
      subagentStop: [{ command: "./stop.sh" }],
    });
  });

  it("never honors hooks on a project agent", () => {
    expect(resolveAgentHooks({ ...base, scope: "project", hooks }, parent)).toBe(parent);
    expect(resolveAgentHooks({ ...base, scope: "project", hooks }, undefined)).toBeUndefined();
  });
});

describe("effortProviderOptions", () => {
  it("maps effort onto the thinking controls", () => {
    expect(effortProviderOptions(undefined)).toBeUndefined();
    expect(effortProviderOptions("low")).toEqual({ thinking: false, reasoningEffort: undefined });
    expect(effortProviderOptions("medium")).toEqual({ thinking: true, reasoningEffort: "high" });
    expect(effortProviderOptions("max")).toEqual({ thinking: true, reasoningEffort: "max" });
  });
});

function skill(id: string, content: string, enabled = true): Skill {
  return {
    id,
    scope: "project",
    name: id,
    description: "",
    tags: [],
    triggers: [],
    priority: 0,
    enabled,
    risk: "low",
    content,
  };
}

describe("buildPreloadedSkills", () => {
  it("preloads bodies in order and names unavailable ones", () => {
    const text = buildPreloadedSkills(["a", "missing", "off"], [skill("a", "Do A."), skill("off", "x", false)])!;
    expect(text).toContain("### Skill: a\nDo A.");
    expect(text).toContain("Unavailable skills, not preloaded: missing, off");
  });

  it("stays within the budget and points at read_skill for the rest", () => {
    const text = buildPreloadedSkills(["big", "next"], [skill("big", "x".repeat(50_000)), skill("next", "y")])!;
    expect(text.length).toBeLessThanOrEqual(SUBAGENT_SKILLS_MAX_CHARS + 200);
    expect(text).toContain('call read_skill("big")');
    expect(text).toContain('call read_skill("next")');
  });

  it("returns undefined without skills", () => {
    expect(buildPreloadedSkills(undefined, [])).toBeUndefined();
    expect(buildPreloadedSkills([], [])).toBeUndefined();
  });
});

/** Records each nested call's policy and hooks; asks for confirmation on writes. */
function recordingDispatcher(): ToolDispatcher & {
  calls: { call: ToolCall; approvalMode: string; hooks: HookConfig | undefined; confirmed?: unknown }[];
} {
  const calls: { call: ToolCall; approvalMode: string; hooks: HookConfig | undefined; confirmed?: unknown }[] = [];
  return {
    calls,
    list: () => [tool("read_file"), tool("write_file"), tool("run_command")],
    execute: async (call: ToolCall, ctx: ToolContext): Promise<ToolResult> => {
      const entry: (typeof calls)[number] = { call, approvalMode: ctx.policy.approvalMode, hooks: ctx.hooks };
      if (call.name === "write_file") {
        entry.confirmed = await ctx.confirm({
          toolName: "write_file",
          permission: "write",
          description: "w",
          path: "a",
        });
      }
      calls.push(entry);
      return { ok: true, data: {} };
    },
  };
}

describe("dispatch applies the definition policy", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-policy-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  async function dispatchOnce(
    def: AgentDefinition,
    nestedCall: string,
    opts: { confirm?: () => Promise<boolean> } = {},
  ) {
    let nestedTurns = 0;
    const provider = routedProvider((req) => {
      if (isParentRequest(req)) {
        return req.messages.some((m) => m.role === "tool")
          ? response({ content: "done" })
          : toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: def.id, task: "go" }));
      }
      nestedTurns++;
      return nestedTurns === 1
        ? toolCallsResponse(toolCall("n1", nestedCall, { path: "a" }))
        : response({ content: "ok" });
    });
    const dispatcher = recordingDispatcher();
    const prompts: string[] = [];
    const events = await collect(
      createAgentCore({
        provider,
        dispatcher,
        confirm: async (req) => {
          prompts.push(req.description);
          return (await opts.confirm?.()) ?? true;
        },
        hooks: { preToolUse: [{ command: "./parent.sh" }] },
        subagents: [def],
      }).runTask({ task: "t", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );
    return { events, dispatcher, prompts, provider };
  }

  it("clamps a project agent's bypassPermissions to the parent's confirm mode", async () => {
    const { dispatcher, prompts } = await dispatchOnce({ ...base, permissionMode: "bypassPermissions" }, "read_file");
    expect(dispatcher.calls[0]!.approvalMode).toBe("confirm");
    expect(prompts[0]).toBe("Dispatch agent fixer (approval mode confirm): go");
  });

  it("runs a global agent with the mode it declares and says so in the dispatch prompt", async () => {
    const { dispatcher, prompts } = await dispatchOnce(
      { ...base, scope: "global", permissionMode: "bypassPermissions" },
      "read_file",
    );
    expect(dispatcher.calls[0]!.approvalMode).toBe("auto");
    expect(prompts[0]).toBe("Dispatch agent fixer (approval mode auto): go");
  });

  it("answers every nested prompt with no under dontAsk", async () => {
    const { dispatcher, prompts } = await dispatchOnce({ ...base, permissionMode: "dontAsk" }, "write_file");
    expect(dispatcher.calls[0]!.confirmed).toBe(false);
    // Only the dispatch itself reached the user.
    expect(prompts).toEqual(["Dispatch agent fixer (never prompts): go"]);
  });

  it("merges a trusted agent's hooks into the nested run and ignores a project agent's", async () => {
    const hooks: HookConfig = { preToolUse: [{ command: "./agent.sh" }] };
    const trusted = await dispatchOnce({ ...base, scope: "global", hooks }, "read_file");
    expect(trusted.dispatcher.calls[0]!.hooks?.preToolUse).toEqual([
      { command: "./parent.sh" },
      { command: "./agent.sh" },
    ]);
    const project = await dispatchOnce({ ...base, scope: "project", hooks }, "read_file");
    expect(project.dispatcher.calls[0]!.hooks?.preToolUse).toEqual([{ command: "./parent.sh" }]);
  });

  it("removes disallowed tools from the nested run", async () => {
    const { provider, dispatcher, events } = await dispatchOnce(
      { ...base, disallowedTools: ["run_command"] },
      "run_command",
    );
    const nested = provider.requests.find((req) => !isParentRequest(req))!;
    expect(nested.tools!.map((t) => t.name)).toEqual(["read_file", "write_file", "agent_report"]);
    expect(dispatcher.calls).toHaveLength(0);
    expect(events.some((e) => e.type === "session.completed")).toBe(true);
  });

  it("puts the color on the dispatch lifecycle events", async () => {
    const { events } = await dispatchOnce({ ...base, mode: "ask", color: "green" }, "read_file");
    const lifecycle = events.filter((e) => e.type.startsWith("subagent."));
    expect(lifecycle.length).toBeGreaterThanOrEqual(3);
    expect(lifecycle.every((e) => (e as { color?: string }).color === "green")).toBe(true);
  });

  it("routes effort through providerForModel and preloads skills into the prompt", async () => {
    const parent = fakeProvider([
      toolCallsResponse(toolCall("d1", "dispatch_agent", { agentId: "thinker", task: "think" })),
      response({ content: "done" }),
    ]);
    const nested = fakeProvider([response({ content: "thought" })]);
    const calls: unknown[][] = [];
    await collect(
      createAgentCore({
        provider: parent,
        providerForModel: (...args) => {
          calls.push(args);
          return nested;
        },
        dispatcher: recordingDispatcher(),
        confirm: async () => true,
        skillSnapshot: [skill("bugfix", "Reproduce first.")],
        subagents: [{ ...base, id: "thinker", mode: "ask", effort: "high", skills: ["bugfix"] }],
      }).runTask({ task: "t", mode: "edit", approvalMode: "confirm", projectPath: workspace }),
    );
    expect(calls).toEqual([["fake", { thinking: true, reasoningEffort: "high" }]]);
    expect(nested.requests[0]!.messages[0]!.content).toContain("### Skill: bugfix\nReproduce first.");
  });
});

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse, PermissionRequest, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createAgentCore, type AgentCoreDeps } from "../../src/agent/loop.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import type { AgentDefinition } from "../../src/subagents/index.js";
import { configureSkillSources } from "../../src/skills/index.js";
import { call, makeCtx } from "../tools/helpers.js";
import { makeSkill, makeTempDir, writeSkillDir } from "./helpers.js";
import { createSkillSession } from "../../src/skills/invocation.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };
const text = (content: string): ChatResponse => ({ content, toolCalls: [], usage: USAGE, finishReason: "stop" });
let callId = 0;
const toolCall = (name: string, args: unknown): ChatResponse => ({
  content: "",
  toolCalls: [{ id: `c${callId++}`, name, argumentsJson: JSON.stringify(args) }],
  usage: USAGE,
  finishReason: "tool_calls",
});

function scripted(model: string, script: ChatResponse[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest): Promise<ChatResponse> => {
    requests.push(req);
    const res = script.shift();
    if (!res) throw new Error(`${model}: script exhausted`);
    return res;
  };
  return { model, requests, chat: next, chatStream: (req) => next(req) };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function results(events: AgentEvent[], toolName: string): ToolResult[] {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "tool.completed" }> => event.type === "tool.completed")
    .filter((event) => event.toolName === toolName)
    .map((event) => event.result);
}

let previousHome: string | undefined;
let home: string;
let workspace: string;

beforeEach(() => {
  previousHome = process.env.SEEKFORGE_HOME;
  home = makeTempDir();
  workspace = makeTempDir();
  process.env.SEEKFORGE_HOME = home;
  configureSkillSources({});
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function userSkill(id: string, frontmatter: string, body = "Write the notes file."): void {
  writeSkillDir(path.join(home, ".seekforge", "skills"), id, undefined, `---\n${frontmatter}\n---\n${body}\n`);
}

function projectSkill(id: string, frontmatter: string, body = "Write the notes file."): void {
  writeSkillDir(path.join(workspace, ".claude", "skills"), id, undefined, `---\n${frontmatter}\n---\n${body}\n`);
}

function deps(provider: ChatProvider, prompts: PermissionRequest[], extra: Partial<AgentCoreDeps> = {}): AgentCoreDeps {
  return {
    provider,
    dispatcher: createDefaultDispatcher(),
    confirm: async (request) => {
      prompts.push(request);
      return false;
    },
    injectSkills: true,
    ...extra,
  };
}

const input = () => ({
  projectPath: workspace,
  task: "take notes",
  mode: "edit" as const,
  approvalMode: "confirm" as const,
});

describe("invoke_skill in an agent run", () => {
  it("lists the skill, returns its instructions, and applies a user skill's tool rules for the run", async () => {
    userSkill(
      "notes",
      "description: Keep notes\nargument-hint: [topic]\nallowed-tools: Write\ndisallowed-tools: Bash",
      "Write notes about $ARGUMENTS.",
    );
    const provider = scripted("flash", [
      toolCall("invoke_skill", { name: "notes", arguments: "caching" }),
      toolCall("write_file", { path: "notes.txt", content: "hello" }),
      toolCall("run_command", { command: "echo hi" }),
      text("done"),
    ]);
    const prompts: PermissionRequest[] = [];
    const events = await collect(createAgentCore(deps(provider, prompts)).runTask(input()));

    const system = String(provider.requests[0]!.messages[0]!.content);
    expect(system).toContain("Skills you can load with invoke_skill");
    // "take notes" also selects it lexically, so the listing marks the excerpt.
    expect(system).toContain("- notes: Keep notes (args: [topic]; excerpt already above)");

    const invoked = results(events, "invoke_skill")[0]!;
    expect(invoked.ok).toBe(true);
    expect(invoked.data).toMatchObject({
      skill: "notes",
      instructions: "Write notes about caching.",
      activeRules: ["deny run_command", "allow write_file"],
    });
    // Pre-approved: no prompt, and the file exists.
    expect(results(events, "write_file")[0]!.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8")).toBe("hello");
    expect(prompts.map((prompt) => prompt.toolName)).not.toContain("write_file");
    // Restricted: refused without a prompt.
    expect(results(events, "run_command")[0]!.error?.code).toBe("denied_by_rule");
  });

  it("does not let a project skill pre-approve a write", async () => {
    projectSkill("notes", "description: Keep notes\nallowed-tools: Write");
    const provider = scripted("flash", [
      toolCall("invoke_skill", { name: "notes" }),
      toolCall("write_file", { path: "notes.txt", content: "hello" }),
      text("done"),
    ]);
    const prompts: PermissionRequest[] = [];
    const events = await collect(createAgentCore(deps(provider, prompts)).runTask(input()));
    expect((results(events, "invoke_skill")[0]!.data as { notes?: string[] }).notes).toContain(
      "allowed-tools was not applied: a project skill may restrict tools but never pre-approve them",
    );
    expect(prompts.map((prompt) => prompt.toolName)).toEqual(["write_file"]);
    expect(results(events, "write_file")[0]!.error?.code).toBe("denied_by_user");
    expect(fs.existsSync(path.join(workspace, "notes.txt"))).toBe(false);
  });

  it("keeps a skill's rules inside the run that activated it", async () => {
    userSkill("notes", "description: Keep notes\nallowed-tools: Write");
    const prompts: PermissionRequest[] = [];
    const core = createAgentCore(
      deps(
        scripted("flash", [
          toolCall("invoke_skill", { name: "notes" }),
          text("first run done"),
          toolCall("write_file", { path: "later.txt", content: "x" }),
          text("second run done"),
        ]),
        prompts,
      ),
    );
    await collect(core.runTask(input()));
    const events = await collect(core.runTask(input()));
    expect(prompts.map((prompt) => prompt.toolName)).toEqual(["write_file"]);
    expect(results(events, "write_file")[0]!.error?.code).toBe("denied_by_user");
  });

  it("switches the model for the rest of the run when the host can", async () => {
    userSkill("deep", "description: Think hard\nmodel: pro");
    const flash = scripted("flash", [toolCall("invoke_skill", { name: "deep" })]);
    const pro = scripted("pro", [text("thought hard")]);
    const events = await collect(
      createAgentCore(deps(flash, [], { providerForModel: (model) => (model === "pro" ? pro : flash) })).runTask({
        ...input(),
        approvalMode: "auto",
      }),
    );
    expect(pro.requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "session.completed" });
  });

  it("refuses a skill that only the user may invoke", async () => {
    userSkill("manual", "description: Manual only\ndisable-model-invocation: true");
    const provider = scripted("flash", [toolCall("invoke_skill", { name: "manual" }), text("ok")]);
    const events = await collect(createAgentCore(deps(provider, [])).runTask(input()));
    expect(String(provider.requests[0]!.messages[0]!.content)).not.toContain("- manual");
    expect(results(events, "invoke_skill")[0]!.error).toMatchObject({
      code: "skill_not_found",
      message: expect.stringContaining("can only be invoked by the user"),
    });
  });

  it("runs a forked skill in a subagent that inherits the skill's restrictions", async () => {
    userSkill("isolated", "description: Work alone\ncontext: fork\ndisallowed-tools: Write", "Investigate $0.");
    const helper: AgentDefinition = {
      id: "helper",
      name: "Helper",
      description: "helps",
      triggers: [],
      mode: "edit",
      scope: "project",
    };
    const provider = scripted("flash", [
      toolCall("invoke_skill", { name: "isolated", arguments: "cache layer" }),
      toolCall("write_file", { path: "forked.txt", content: "nope" }),
      text("fork report"),
      text("parent done"),
    ]);
    const events = await collect(
      createAgentCore(deps(provider, [], { subagents: [helper] })).runTask({ ...input(), approvalMode: "auto" }),
    );
    const nestedRequest = provider.requests[1]!;
    expect(String(nestedRequest.messages[0]!.content)).toContain("skill:isolated");
    expect(nestedRequest.messages[1]).toMatchObject({ role: "user", content: "Investigate cache." });
    expect(results(events, "invoke_skill")[0]!.data).toMatchObject({
      skill: "isolated",
      context: "fork",
      agent: "skill:isolated",
      report: "fork report",
    });
    expect(fs.existsSync(path.join(workspace, "forked.txt"))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent.completed", agentId: "skill:isolated" }));
  });

  it("keeps an inline skill's restrictions on subagents dispatched after it", async () => {
    userSkill("careful", "description: Be careful\ndisallowed-tools: Write");
    const helper: AgentDefinition = {
      id: "helper",
      name: "Helper",
      description: "helps",
      triggers: [],
      mode: "edit",
      scope: "project",
    };
    const provider = scripted("flash", [
      toolCall("invoke_skill", { name: "careful" }),
      toolCall("dispatch_agent", { agentId: "helper", task: "write it" }),
      toolCall("write_file", { path: "escaped.txt", content: "nope" }),
      text("helper report"),
      text("parent done"),
    ]);
    const events = await collect(
      createAgentCore(deps(provider, [], { subagents: [helper] })).runTask({ ...input(), approvalMode: "auto" }),
    );
    expect(results(events, "dispatch_agent")[0]!.ok).toBe(true);
    expect(fs.existsSync(path.join(workspace, "escaped.txt"))).toBe(false);
  });

  it("asks before forking an editing subagent in confirm mode", async () => {
    userSkill("isolated", "description: Work alone\ncontext: fork");
    const provider = scripted("flash", [toolCall("invoke_skill", { name: "isolated" }), text("parent done")]);
    const prompts: PermissionRequest[] = [];
    const events = await collect(
      createAgentCore(
        deps(provider, prompts, {
          subagents: [{ id: "helper", name: "Helper", description: "", triggers: [], mode: "edit", scope: "project" }],
        }),
      ).runTask(input()),
    );
    expect(prompts).toEqual([
      expect.objectContaining({
        toolName: "invoke_skill",
        permission: "write",
        description: "Invoke skill isolated in a subagent",
      }),
    ]);
    expect(results(events, "invoke_skill")[0]!.error?.code).toBe("denied_by_user");
    expect(provider.requests).toHaveLength(2);
  });

  it("runs a fork skill inline, without a write prompt, when the host has no subagents", async () => {
    userSkill("isolated", "description: Work alone\ncontext: fork", "Do it here.");
    const provider = scripted("flash", [toolCall("invoke_skill", { name: "isolated" }), text("done")]);
    const prompts: PermissionRequest[] = [];
    const events = await collect(createAgentCore(deps(provider, prompts)).runTask(input()));
    expect(prompts).toEqual([]);
    expect(results(events, "invoke_skill")[0]!.data).toMatchObject({
      instructions: "Do it here.",
      notes: ["this host cannot run skills in a subagent, so the skill runs inline"],
    });
  });
});

describe("invoke_skill outside a run", () => {
  it("loads from the workspace and says the rules were not applied", async () => {
    userSkill("notes", "description: Keep notes\nallowed-tools: Write");
    const result = await createDefaultDispatcher().execute(call("invoke_skill", { name: "notes" }), makeCtx(workspace));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      instructions: "Write the notes file.",
      notes: ["allowed-tools, disallowed-tools and model are not applied outside an agent run"],
    });
  });

  it("answers a repeat load briefly and lists what exists for an unknown name", async () => {
    const skill = makeSkill("repeat", { content: "Body." });
    const ctx = makeCtx(workspace);
    ctx.skills = createSkillSession({ skills: [skill], policy: ctx.policy, workspace, mode: "edit" });
    const dispatcher = createDefaultDispatcher();
    expect((await dispatcher.execute(call("invoke_skill", { name: "repeat" }), ctx)).data).toMatchObject({
      instructions: "Body.",
    });
    expect((await dispatcher.execute(call("invoke_skill", { name: "repeat" }), ctx)).data).toMatchObject({
      alreadyLoaded: true,
    });
    expect((await dispatcher.execute(call("invoke_skill", { name: "repeat", reload: true }), ctx)).data).toMatchObject({
      instructions: "Body.",
    });
    const missing = await dispatcher.execute(call("invoke_skill", { name: "nope" }), ctx);
    expect(missing.error).toMatchObject({ code: "skill_not_found", message: expect.stringContaining("repeat") });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import {
  createRuleActivation,
  loadProjectRules,
  MAX_ACTIVATED_RULES_BYTES,
  type RuleActivation,
} from "../../src/agent/rules.js";

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seekforge-home-"));
  workspace = mkdtempSync(join(tmpdir(), "seekforge-activation-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  mkdirSync(dirname(join(workspace, rel)), { recursive: true });
  writeFileSync(join(workspace, rel), content);
}

function activation(task?: string): RuleActivation {
  return createRuleActivation(workspace, loadProjectRules(workspace, { home, ...(task ? { task } : {}) }));
}

describe("mid-run rule activation", () => {
  it("loads a subdirectory AGENTS.md once a file below it is touched", () => {
    write("packages/api/AGENTS.md", "API RULES");
    write("packages/api/src/handler.ts", "");
    const rules = activation();
    rules.touch("packages/web/index.ts");
    expect(rules.takePending()).toBeUndefined();
    rules.touch("packages/api/src/handler.ts");
    const injected = rules.takePending()!;
    expect(injected.origins).toEqual(["packages/api/AGENTS.md"]);
    expect(injected.message).toContain("<!-- from: packages/api/AGENTS.md -->\nAPI RULES");
    expect(injected.message.startsWith("[harness]")).toBe(true);
    rules.touch("packages/api/src/other.ts");
    expect(rules.takePending()).toBeUndefined();
  });

  it("loads outer directories before inner ones, and CLAUDE.md beside AGENTS.md", () => {
    write("a/AGENTS.md", "OUTER");
    write("a/b/CLAUDE.md", "INNER CLAUDE");
    const rules = activation();
    rules.touch("a/b/c/file.ts");
    expect(rules.takePending()!.origins).toEqual(["a/AGENTS.md", "a/b/CLAUDE.md"]);
  });

  it("does not repeat a subdirectory file the task already put in the prompt", () => {
    write("packages/api/AGENTS.md", "API RULES");
    const rules = activation("fix packages/api/src/handler.ts");
    rules.touch("packages/api/src/handler.ts");
    expect(rules.takePending()).toBeUndefined();
  });

  it("ignores rules in dependencies, dot-directories, and gitignored trees", () => {
    write(".gitignore", "generated/\n");
    write("node_modules/pkg/AGENTS.md", "DEP RULES");
    write(".venv/lib/AGENTS.md", "VENV RULES");
    write("generated/AGENTS.md", "GENERATED RULES");
    const rules = activation();
    rules.touch("node_modules/pkg/index.js");
    rules.touch(".venv/lib/x.py");
    rules.touch("generated/out.ts");
    expect(rules.takePending()).toBeUndefined();
  });

  it("ignores paths outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "seekforge-activation-out-"));
    mkdirSync(join(outside, "sub"));
    writeFileSync(join(outside, "sub", "AGENTS.md"), "OUTSIDE");
    const rules = activation();
    rules.touch(join(outside, "sub", "x.ts"));
    rules.touch("../x.ts");
    expect(rules.takePending()).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });

  it("loads a path-scoped rule when a matching file is touched", () => {
    write(".seekforge/rules/api.md", "---\npaths: src/api/**/*.ts\n---\nAPI SCOPED");
    write(".claude/rules/tests.md", "---\npaths:\n  - '*.test.ts'\n---\nTEST SCOPED");
    const rules = activation();
    rules.touch("src/web/app.ts");
    expect(rules.takePending()).toBeUndefined();
    rules.touch("./src/api/v1/users.ts");
    const first = rules.takePending()!;
    expect(first.origins).toEqual([".seekforge/rules/api.md"]);
    expect(first.message).toContain("<!-- from: .seekforge/rules/api.md (paths: src/api/**/*.ts) -->\nAPI SCOPED");
    rules.touch("deep/dir/users.test.ts");
    expect(rules.takePending()!.origins).toEqual([".claude/rules/tests.md"]);
    rules.touch("src/api/other.ts");
    expect(rules.takePending()).toBeUndefined();
  });

  it("skips what does not fit the run's allowance, and says so", () => {
    write("big/AGENTS.md", "x".repeat(MAX_ACTIVATED_RULES_BYTES));
    write("small/AGENTS.md", "SMALL");
    const rules = activation();
    rules.touch("big/a.ts");
    const skipped = rules.takePending()!;
    expect(skipped.origins).toEqual([]);
    expect(skipped.skipped).toEqual(["big/AGENTS.md"]);
    rules.touch("big/b.ts");
    expect(rules.takePending()).toBeUndefined();
    rules.touch("small/a.ts");
    expect(rules.takePending()!.origins).toEqual(["small/AGENTS.md"]);
  });

  it("re-adds only the activated rules that compaction dropped", () => {
    write("a/AGENTS.md", "RULE A");
    write("b/AGENTS.md", "RULE B");
    const rules = activation();
    rules.touch("a/x.ts");
    const a = rules.takePending()!;
    rules.touch("b/x.ts");
    const b = rules.takePending()!;
    const kept: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: b.message },
    ];
    const again = rules.reinject(kept)!;
    expect(again.origins).toEqual(["a/AGENTS.md"]);
    expect(again.message).toContain("RULE A");
    expect(rules.reinject([...kept, { role: "user", content: again.message }])).toBeUndefined();
    expect(a.origins).toEqual(["a/AGENTS.md"]);
  });
});

// ---------------------------------------------------------------------------
// Loop integration
// ---------------------------------------------------------------------------

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function fakeProvider(script: ChatResponse[]): ChatProvider & { requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  const next = async (req: ChatRequest) => {
    requests.push([...req.messages]);
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", requests, chat: next, chatStream: (req) => next(req) };
}

function toolTurn(name: string, args: unknown): ChatResponse {
  return {
    content: "",
    toolCalls: [{ id: `c-${Math.random().toString(36).slice(2, 8)}`, name, argumentsJson: JSON.stringify(args) }],
    usage: USAGE,
    finishReason: "tool_calls",
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("agent loop rule activation", () => {
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env["HOME"];
    process.env["HOME"] = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  });

  it("injects touched-path rules before the next model turn, once", async () => {
    write("packages/api/AGENTS.md", "API-NESTED-MARKER");
    write(".seekforge/rules/ts.md", "---\npaths: ['**/*.ts']\n---\nTS-SCOPED-MARKER");
    write("packages/api/src/a.ts", "export const a = 1;\n");
    const provider = fakeProvider([
      toolTurn("read_file", { path: "packages/api/src/a.ts" }),
      toolTurn("read_file", { path: "packages/api/src/a.ts" }),
      { content: "done", toolCalls: [], usage: USAGE, finishReason: "stop" },
    ]);
    const agent = createAgentCore({ provider, dispatcher: createDefaultDispatcher(), confirm: async () => true });
    const events = await collect(
      agent.runTask({ projectPath: workspace, task: "look around", mode: "edit", approvalMode: "auto" }),
    );

    expect(provider.requests[0]!.some((m) => m.content.includes("API-NESTED-MARKER"))).toBe(false);
    const second = provider.requests[1]!;
    const injected = second[second.length - 1]!;
    expect(injected.role).toBe("user");
    expect(injected.content).toContain("API-NESTED-MARKER");
    expect(injected.content).toContain("TS-SCOPED-MARKER");
    const third = provider.requests[2]!;
    expect(third.filter((m) => m.content.includes("API-NESTED-MARKER"))).toHaveLength(1);
    expect(events).toContainEqual({
      type: "step.started",
      title: "rules: packages/api/AGENTS.md, .seekforge/rules/ts.md",
    });
  });

  it("refuses an unread edit through the loop and accepts it after a read", async () => {
    write("a.txt", "old\n");
    const provider = fakeProvider([
      toolTurn("apply_patch", { path: "a.txt", edits: [{ oldString: "old", newString: "new" }] }),
      toolTurn("read_file", { path: "a.txt" }),
      toolTurn("apply_patch", { path: "a.txt", edits: [{ oldString: "old", newString: "new" }] }),
      { content: "done", toolCalls: [], usage: USAGE, finishReason: "stop" },
    ]);
    const agent = createAgentCore({ provider, dispatcher: createDefaultDispatcher(), confirm: async () => true });
    const events = await collect(
      agent.runTask({ projectPath: workspace, task: "edit a.txt", mode: "edit", approvalMode: "auto" }),
    );
    const results = events.flatMap((e) => (e.type === "tool.completed" ? [e.result] : []));
    expect(results.map((r) => r.ok)).toEqual([false, true, true]);
    expect(results[0]!.error?.code).toBe("file_not_read");
  });
});

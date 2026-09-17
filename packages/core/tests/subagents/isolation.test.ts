import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, PermissionRequest, ToolCall, ToolResult } from "@seekforge/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentCore } from "../../src/agent/loop.js";
import { acquireAgentEditLock, tryAcquireAgentEditLock } from "../../src/subagents/isolation.js";
import type { AgentDefinition } from "../../src/subagents/types.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import {
  collect,
  deferred,
  isParentRequest,
  response,
  routedProvider,
  settle,
  toolCall,
  toolCallsResponse,
  toolCompleted,
} from "./helpers.js";

const fixer: AgentDefinition = {
  id: "fixer",
  name: "Fixer",
  description: "fixes",
  triggers: [],
  mode: "edit",
  scope: "project",
  isolation: "worktree",
};

describe("workspace edit lock", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-lock-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("serializes holders in arrival order and lets a cancelled waiter leave", async () => {
    const first = tryAcquireAgentEditLock(workspace)!;
    expect(first).toBeTypeOf("function");
    expect(tryAcquireAgentEditLock(workspace)).toBeUndefined();

    const order: string[] = [];
    const second = acquireAgentEditLock(workspace).then((release) => {
      order.push("second");
      return release;
    });
    const aborted = new AbortController();
    const cancelled = acquireAgentEditLock(workspace, aborted.signal);
    const third = acquireAgentEditLock(workspace).then((release) => {
      order.push("third");
      return release;
    });
    aborted.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);
    await settle();
    expect(order).toEqual([]);

    first();
    first(); // idempotent
    const releaseSecond = await second;
    await settle();
    expect(order).toEqual(["second"]);
    releaseSecond();
    (await third)();
    expect(order).toEqual(["second", "third"]);

    const again = tryAcquireAgentEditLock(workspace);
    expect(again).toBeTypeOf("function");
    again!();
  });
});

/** Writes files under the nested run's own workspace and records where it ran. */
function writingDispatcher(): ToolDispatcher & { workspaces: string[] } {
  const workspaces: string[] = [];
  return {
    workspaces,
    list: () => [
      { name: "read_file", description: "d", parameters: {} },
      { name: "write_file", description: "d", parameters: {} },
    ],
    execute: async (call: ToolCall, ctx: ToolContext): Promise<ToolResult> => {
      workspaces.push(ctx.workspace);
      if (call.name !== "write_file") return { ok: true, data: {} };
      const args = call.arguments as { path: string; content: string };
      const target = join(ctx.workspace, args.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, args.content);
      return { ok: true, data: {}, meta: { permission: "write", path: args.path } };
    },
  };
}

describe("concurrent edit dispatches without isolation", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-serial-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("never run two edit agents at once, while a read-only agent still overlaps", async () => {
    const releaseFirst = deferred<void>();
    let activeEdits = 0;
    let maxActiveEdits = 0;
    let readerOverlapped = false;
    const provider = routedProvider(async (req) => {
      if (isParentRequest(req)) {
        return req.messages.some((m) => m.role === "tool")
          ? response({ content: "done" })
          : toolCallsResponse(
              toolCall("d1", "dispatch_agent", { agentId: "editor", task: "edit one" }),
              toolCall("d2", "dispatch_agent", { agentId: "editor", task: "edit two" }),
              toolCall("d3", "dispatch_agent", { agentId: "reader", task: "read along" }),
            );
      }
      const task = req.messages.find((m) => m.role === "user")?.content ?? "";
      if (task.includes("read along")) {
        readerOverlapped = activeEdits === 1;
        releaseFirst.resolve();
        return response({ content: "read" });
      }
      activeEdits++;
      maxActiveEdits = Math.max(maxActiveEdits, activeEdits);
      if (task.includes("edit one")) await releaseFirst.promise;
      activeEdits--;
      return response({ content: "edited" });
    });
    const editor: AgentDefinition = { ...fixer, id: "editor", isolation: undefined };
    const reader: AgentDefinition = { ...fixer, id: "reader", mode: "ask", isolation: undefined };
    const events = await collect(
      createAgentCore({
        provider,
        dispatcher: writingDispatcher(),
        confirm: async () => true,
        subagents: [editor, reader],
      }).runTask({ task: "t", mode: "edit", approvalMode: "auto", projectPath: workspace }),
    );
    expect(maxActiveEdits).toBe(1);
    expect(readerOverlapped).toBe(true);
    expect(toolCompleted(events, "dispatch_agent").every((e) => e.result.ok)).toBe(true);
    expect(
      events.some((e) => e.type === "step.started" && e.title === "[editor] waiting for another edit agent to finish"),
    ).toBe(true);
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("isolated edit dispatch", () => {
  let repo: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "seekforge-iso-")));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@seekforge.local");
    git(repo, "config", "user.name", "SeekForge Test");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "base.txt"), "base\n");
    writeFileSync(join(repo, ".gitignore"), ".seekforge/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "initial");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Parent dispatches once (then optionally continues with agent_send); nested writes the given files. */
  function scriptedProvider(steps: { parent: unknown[]; nestedWrites: Record<string, string>[] }) {
    let parentTurn = 0;
    let nestedRun = -1;
    return routedProvider((req) => {
      if (isParentRequest(req)) {
        const call = steps.parent[parentTurn++];
        return call ? toolCallsResponse(call as ReturnType<typeof toolCall>) : response({ content: "done" });
      }
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      const alreadyWrote = req.messages.at(-1)?.role === "tool";
      if (!alreadyWrote) {
        nestedRun++;
        const writes = Object.entries(steps.nestedWrites[nestedRun] ?? {});
        if (writes.length > 0 && lastUser) {
          return toolCallsResponse(
            ...writes.map(([path, content], i) => toolCall(`w${nestedRun}-${i}`, "write_file", { path, content })),
          );
        }
      }
      return response({ content: `report ${nestedRun}` });
    });
  }

  const dispatch = (args: Record<string, unknown> = {}) =>
    toolCall("d1", "dispatch_agent", { agentId: "fixer", task: "change things", ...args });

  function isolationOf(events: AgentEvent[], toolName = "dispatch_agent", index = 0) {
    const result = toolCompleted(events, toolName)[index]!.result;
    return { result, isolation: (result.data as { isolation?: Record<string, unknown> } | undefined)?.isolation };
  }

  it("applies the change to the parent checkout and removes the worktree", async () => {
    const dispatcher = writingDispatcher();
    const events = await collect(
      createAgentCore({
        provider: scriptedProvider({ parent: [dispatch()], nestedWrites: [{ "src/new.txt": "hello\n" }] }),
        dispatcher,
        confirm: async () => true,
        subagents: [fixer],
      }).runTask({ task: "t", mode: "edit", approvalMode: "auto", projectPath: repo }),
    );
    const { result, isolation } = isolationOf(events);
    expect(result.ok).toBe(true);
    expect(isolation).toEqual({ status: "applied", files: ["src/new.txt"] });
    expect((result.data as { changedFiles: string[] }).changedFiles).toEqual(["src/new.txt"]);
    expect(readFileSync(join(repo, "src", "new.txt"), "utf8")).toBe("hello\n");

    // The nested run worked in a worktree, which is gone along with its branch.
    const nestedWorkspace = dispatcher.workspaces[0]!;
    expect(nestedWorkspace.startsWith(join(repo, ".seekforge", "worktrees"))).toBe(true);
    expect(existsSync(nestedWorkspace)).toBe(false);
    expect(git(repo, "branch", "--list", "seekforge/*")).toBe("");

    // The parent reports the applied file, records a checkpoint for rewind,
    // and keeps the nested transcript.
    expect(events.filter((e) => e.type === "file.changed").map((e) => (e as { path: string }).path)).toEqual([
      "src/new.txt",
    ]);
    const parentSession = (events.find((e) => e.type === "session.created") as { sessionId: string }).sessionId;
    const checkpoints = readFileSync(join(repo, ".seekforge", "sessions", parentSession, "checkpoints.jsonl"), "utf8");
    expect(JSON.parse(checkpoints.trim())).toMatchObject({ path: "src/new.txt", before: null });
    const completed = events.find((e) => e.type === "subagent.completed") as { subSessionId?: string };
    expect(existsSync(join(repo, ".seekforge", "sessions", completed.subSessionId!, "messages.jsonl"))).toBe(true);
  });

  it("keeps a denied change on the worktree branch, and agent_send continues there", async () => {
    const prompts: PermissionRequest[] = [];
    let denyApply = true;
    let appliedBeforeSecondReview: boolean | undefined;
    const dispatcher = writingDispatcher();
    const events = await collect(
      createAgentCore({
        provider: scriptedProvider({
          parent: [dispatch(), toolCall("s1", "agent_send", { dispatchId: "ag-1", task: "one more" })],
          nestedWrites: [{ "a.txt": "A\n" }, { "b.txt": "B\n" }],
        }),
        dispatcher,
        confirm: async (req) => {
          prompts.push(req);
          if (req.description.startsWith("Apply") && denyApply) {
            denyApply = false;
            return { allow: false, feedback: "not yet" };
          }
          if (req.description.startsWith("Apply")) appliedBeforeSecondReview = existsSync(join(repo, "a.txt"));
          return true;
        },
        subagents: [fixer],
      }).runTask({ task: "t", mode: "edit", approvalMode: "confirm", projectPath: repo }),
    );

    const first = isolationOf(events);
    expect(first.result.ok).toBe(true);
    expect(first.isolation).toMatchObject({ status: "retained", reason: "denied", files: ["a.txt"] });
    expect(String(first.isolation!["message"])).toContain("The user said: not yet");
    const branch = String(first.isolation!["branch"]);
    // The denied change never reached the checkout.
    expect(appliedBeforeSecondReview).toBe(false);

    const applyPrompt = prompts.find((p) => p.description.startsWith("Apply"))!;
    expect(applyPrompt.toolName).toBe("dispatch_agent");
    expect(applyPrompt.permission).toBe("write");
    expect(applyPrompt.path).toBe("a.txt");
    expect(applyPrompt.preview?.diff).toContain("+A");
    expect(prompts[0]!.description).toBe("Dispatch agent fixer (isolated worktree): change things");

    // agent_send resumed in the retained worktree; both changes apply together.
    expect(dispatcher.workspaces[0]).toBe(dispatcher.workspaces[1]);
    const second = isolationOf(events, "agent_send");
    expect(second.isolation).toEqual({ status: "applied", files: ["a.txt", "b.txt"] });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("A\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("B\n");
    expect(git(repo, "branch", "--list", branch)).toBe("");
  });

  it("does not force a patch that conflicts with the parent's own edits", async () => {
    writeFileSync(join(repo, "base.txt"), "parent edit\n");
    const events = await collect(
      createAgentCore({
        provider: scriptedProvider({ parent: [dispatch()], nestedWrites: [{ "base.txt": "agent edit\n" }] }),
        dispatcher: writingDispatcher(),
        confirm: async () => true,
        subagents: [fixer],
      }).runTask({ task: "t", mode: "edit", approvalMode: "auto", projectPath: repo }),
    );
    const { isolation } = isolationOf(events);
    expect(isolation).toMatchObject({ status: "retained", reason: "conflict", files: ["base.txt"] });
    expect(readFileSync(join(repo, "base.txt"), "utf8")).toBe("parent edit\n");
    const worktree = String(isolation!["worktree"]);
    expect(readFileSync(join(worktree, "base.txt"), "utf8")).toBe("agent edit\n");
    expect(git(worktree, "log", "-1", "--format=%s")).toBe("seekforge agent fixer changes");
  });

  it("refuses a change the parent's deny rules would refuse", async () => {
    const events = await collect(
      createAgentCore({
        provider: scriptedProvider({ parent: [dispatch()], nestedWrites: [{ "secret/key.txt": "k\n" }] }),
        dispatcher: writingDispatcher(),
        confirm: async () => true,
        permissionRules: [{ action: "deny", tool: "write_file", match: "secret/" }],
        subagents: [fixer],
      }).runTask({ task: "t", mode: "edit", approvalMode: "auto", projectPath: repo }),
    );
    const { isolation } = isolationOf(events);
    expect(isolation).toMatchObject({ status: "retained", reason: "refused" });
    expect(existsSync(join(repo, "secret", "key.txt"))).toBe(false);
  });

  it("removes a worktree the agent did not change and honors the dispatch argument", async () => {
    const plain: AgentDefinition = { ...fixer, isolation: undefined };
    const dispatcher = writingDispatcher();
    const events = await collect(
      createAgentCore({
        provider: scriptedProvider({ parent: [dispatch({ isolation: "worktree" })], nestedWrites: [{}] }),
        dispatcher,
        confirm: async () => true,
        subagents: [plain],
      }).runTask({ task: "t", mode: "edit", approvalMode: "auto", projectPath: repo }),
    );
    const { result, isolation } = isolationOf(events);
    expect(result.ok).toBe(true);
    expect(isolation).toEqual({ status: "unchanged" });
    expect(git(repo, "branch", "--list", "seekforge/*")).toBe("");
  });

  it("fails clearly outside a git repository and rejects unknown isolation values", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "seekforge-nogit-"));
    try {
      const events = await collect(
        createAgentCore({
          provider: scriptedProvider({
            parent: [dispatch(), toolCall("d2", "dispatch_agent", { agentId: "fixer", task: "x", isolation: "vm" })],
            nestedWrites: [],
          }),
          dispatcher: writingDispatcher(),
          confirm: async () => true,
          subagents: [fixer],
        }).runTask({ task: "t", mode: "edit", approvalMode: "auto", projectPath: plainDir }),
      );
      const [first, second] = toolCompleted(events, "dispatch_agent");
      expect(first!.result.error?.code).toBe("isolation_unavailable");
      expect(second!.result.error?.code).toBe("invalid_arguments");
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("runs a read-only agent in place even when isolation is requested", async () => {
    const dispatcher = writingDispatcher();
    await collect(
      createAgentCore({
        provider: scriptedProvider({ parent: [dispatch({ isolation: "worktree" })], nestedWrites: [] }),
        dispatcher,
        confirm: async () => true,
        subagents: [{ ...fixer, mode: "ask" }],
      }).runTask({ task: "t", mode: "edit", approvalMode: "auto", projectPath: repo }),
    );
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });
});

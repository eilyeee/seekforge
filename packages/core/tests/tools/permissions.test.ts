import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfirmResult, PermissionRequest, PermissionRule } from "@seekforge/shared";
import { createDefaultDispatcher, enforcePermission } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

function scriptedConfirm(answer: ConfirmResult): {
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  requests: PermissionRequest[];
} {
  const requests: PermissionRequest[] = [];
  return {
    requests,
    confirm: async (req) => {
      requests.push(req);
      return answer;
    },
  };
}

describe("permission flow", () => {
  it("readonly tools run without confirmation, even in ask mode", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "hi");
    const { confirm, requests } = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { mode: "ask", approvalMode: "confirm" }, confirm });
    const res = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("blocks any write in ask mode without prompting", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const ctx = makeCtx(ws, { policy: { mode: "ask", approvalMode: "auto" }, confirm });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("forbidden_in_ask_mode");
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(path.join(ws, "a.txt"))).toBe(false);
  });

  it("auto-allows writes when approvalMode is auto", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("confirms writes when approvalMode is confirm — approve runs, deny blocks", async () => {
    const ws = makeWorkspace();

    const approve = scriptedConfirm(true);
    const okRes = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "x" }),
      makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm: approve.confirm }),
    );
    expect(okRes.ok).toBe(true);
    expect(approve.requests).toHaveLength(1);
    expect(approve.requests[0]?.permission).toBe("write");
    expect(approve.requests[0]?.path).toBe("a.txt"); // raw path surfaced

    const deny = scriptedConfirm(false);
    const denyRes = await dispatcher.execute(
      call("write_file", { path: "b.txt", content: "x" }),
      makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm: deny.confirm }),
    );
    expect(denyRes.ok).toBe(false);
    expect(denyRes.error?.code).toBe("denied_by_user");
    expect(fs.existsSync(path.join(ws, "b.txt"))).toBe(false);
  });

  it("auto-runs allowlisted commands but confirms unknown ones", async () => {
    const ws = makeWorkspace();
    const allow = scriptedConfirm(true);
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm: allow.confirm });

    const allowlisted = await dispatcher.execute(call("run_command", { command: "pwd" }), ctx);
    expect(allowlisted.ok).toBe(true);
    expect(allow.requests).toHaveLength(0);

    const unknown = await dispatcher.execute(call("run_command", { command: "echo hi" }), ctx);
    expect(unknown.ok).toBe(true);
    expect(allow.requests).toHaveLength(1);
    expect(allow.requests[0]?.command).toBe("echo hi"); // raw command surfaced
  });

  it("auto mode runs unknown (non-env) commands without confirming", async () => {
    const ws = makeWorkspace();
    const allow = scriptedConfirm(true);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm: allow.confirm });

    // "auto" is the full-bypass tier: a non-allowlisted execute command runs
    // without a prompt (matches the -y / bypassPermissions contract and lets
    // headless runs execute commands instead of auto-denying).
    const unknown = await dispatcher.execute(call("run_command", { command: "echo hi" }), ctx);
    expect(unknown.ok).toBe(true);
    expect(allow.requests).toHaveLength(0); // never prompted
  });

  it("env-level commands always confirm, even with approvalMode auto", async () => {
    const ws = makeWorkspace();
    const deny = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm: deny.confirm });
    const res = await dispatcher.execute(
      call("run_command", { command: "pnpm install left-pad" }),
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(deny.requests).toHaveLength(1);
    expect(deny.requests[0]?.permission).toBe("env");
    expect(deny.requests[0]?.command).toBe("pnpm install left-pad");
  });

  it("denies dangerous commands without ever prompting", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto" }, confirm });
    const res = await dispatcher.execute(
      call("run_command", { command: "sudo rm -rf /" }),
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(requests).toHaveLength(0);
  });
});

describe("permission rules", () => {
  it("deny rule blocks a readonly tool without prompting (deny wins over everything)", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "secret.txt"), "hidden");
    const { confirm, requests } = scriptedConfirm(true);
    const rules: PermissionRule[] = [{ action: "deny", tool: "read_file" }];
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto", rules }, confirm });
    const res = await dispatcher.execute(call("read_file", { path: "secret.txt" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_rule");
    expect(requests).toHaveLength(0);
  });

  it("deny rule blocks an allowlisted command", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const rules: PermissionRule[] = [{ action: "deny", tool: "run_command", match: "pwd" }];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });
    // "pwd" is on the builtin allowlist, but the deny rule still wins.
    const res = await dispatcher.execute(call("run_command", { command: "pwd" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_rule");
    expect(requests).toHaveLength(0);
  });

  it("deny by command prefix blocks one npm script but not another", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const rules: PermissionRule[] = [
      { action: "deny", tool: "run_command", match: "npm run deploy" },
    ];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });

    const blocked = await dispatcher.execute(
      call("run_command", { command: "npm run deploy --prod" }),
      ctx,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe("denied_by_rule");
    expect(requests).toHaveLength(0);

    // A different script is not rule-denied: it reaches the normal confirm flow.
    const other = await dispatcher.execute(call("run_command", { command: "npm run lint" }), ctx);
    expect(other.ok).toBe(false);
    expect(other.error?.code).toBe("denied_by_user");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toBe("npm run lint");
  });

  it("deny rule can't be evaded by inserting extra whitespace", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const rules: PermissionRule[] = [
      { action: "deny", tool: "run_command", match: "npm run deploy" },
    ];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });
    // Extra spaces normalize away — the classifier collapses them the same way
    // before running, so the deny must still catch it.
    const blocked = await dispatcher.execute(
      call("run_command", { command: "npm   run  deploy --prod" }),
      ctx,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe("denied_by_rule");
    expect(requests).toHaveLength(0);
  });

  it("allow rule skips write confirmation", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const rules: PermissionRule[] = [{ action: "allow", tool: "write_file" }];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("x");
  });

  it("allow command rule matches on a token boundary, not a bare prefix", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    // Allowing `npm run build` must NOT auto-approve the sibling `npm run
    // build-all` — that would smuggle a different script past the gate.
    const rules: PermissionRule[] = [{ action: "allow", tool: "run_command", match: "npm run build" }];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });

    const exact = await enforcePermission(
      "run_command",
      { permission: "execute", description: "npm run build", command: "npm run build" },
      ctx,
    );
    expect(exact).toEqual({ allowed: true, decision: "allow_rule" });

    const withArgs = await enforcePermission(
      "run_command",
      { permission: "execute", description: "npm run build --prod", command: "npm run build --prod" },
      ctx,
    );
    expect(withArgs).toEqual({ allowed: true, decision: "allow_rule" });

    const sibling = await enforcePermission(
      "run_command",
      { permission: "execute", description: "npm run build-all", command: "npm run build-all" },
      ctx,
    );
    expect(sibling.allowed).toBe(false);
    expect(sibling.decision).toBe("user_denied");
  });

  it("allow path rule matches on a path boundary, not a sibling prefix", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "x");
    const { confirm } = scriptedConfirm(false);
    // `match: "src/foo"` must not grant `src/foobar.ts`, but must grant
    // `src/foo/x.ts` and `src/foo` itself.
    const rules: PermissionRule[] = [{ action: "allow", tool: "write_file", match: "src/foo" }];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });

    const child = await enforcePermission(
      "write_file",
      { permission: "write", description: "write src/foo/x.ts", path: "src/foo/x.ts" },
      ctx,
    );
    expect(child).toEqual({ allowed: true, decision: "allow_rule" });

    const sibling = await enforcePermission(
      "write_file",
      { permission: "write", description: "write src/foobar.ts", path: "src/foobar.ts" },
      ctx,
    );
    expect(sibling.allowed).toBe(false);
  });

  it("allow rule does NOT rescue a dangerous command", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const rules: PermissionRule[] = [{ action: "allow", tool: "run_command" }];
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto", rules }, confirm });
    const res = await dispatcher.execute(call("run_command", { command: "sudo rm -rf /" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(requests).toHaveLength(0);
  });

  it("allow rule does not bypass ask-mode blocking", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const rules: PermissionRule[] = [{ action: "allow", tool: "write_file" }];
    const ctx = makeCtx(ws, { policy: { mode: "ask", approvalMode: "auto", rules }, confirm });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("forbidden_in_ask_mode");
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(path.join(ws, "a.txt"))).toBe(false);
  });

  it("env-level allow rule skips the prompt (web_fetch for a docs domain)", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const rules: PermissionRule[] = [
      { action: "allow", tool: "web_fetch", match: "GET https://docs.example.com/" },
    ];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });
    // enforcePermission directly: web_fetch.run would hit the real network.
    const allowed = await enforcePermission(
      "web_fetch",
      {
        permission: "env",
        description: "Fetch URL: https://docs.example.com/api",
        command: "GET https://docs.example.com/api",
      },
      ctx,
    );
    expect(allowed).toEqual({ allowed: true, decision: "allow_rule" });
    expect(requests).toHaveLength(0);

    // Other domains still go through the env confirmation.
    const other = await enforcePermission(
      "web_fetch",
      {
        permission: "env",
        description: "Fetch URL: https://evil.example.org/x",
        command: "GET https://evil.example.org/x",
      },
      ctx,
    );
    expect(other.allowed).toBe(false);
    expect(other.decision).toBe("user_denied");
    expect(requests).toHaveLength(1);
  });

  it('tool "*" wildcard matches every tool', async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "hi");
    const { confirm, requests } = scriptedConfirm(true);
    const rules: PermissionRule[] = [{ action: "deny", tool: "*" }];
    const ctx = makeCtx(ws, { policy: { approvalMode: "auto", rules }, confirm });
    const read = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(read.error?.code).toBe("denied_by_rule");
    const write = await dispatcher.execute(call("write_file", { path: "b.txt", content: "x" }), ctx);
    expect(write.error?.code).toBe("denied_by_rule");
    expect(requests).toHaveLength(0);
  });

  it("first-match precedence: deny scanned before allow, project rules first in the array", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    // Project rules come first in the merged array; the first matching rule
    // of each category wins, and deny is always scanned before allow.
    const rules: PermissionRule[] = [
      { action: "allow", tool: "write_file", match: "src/" }, // project
      { action: "deny", tool: "write_file", match: "src/generated/" }, // project
      { action: "deny", tool: "write_file" }, // global: deny all other writes
    ];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });

    // deny beats a matching allow that appears earlier in the array
    const generated = await dispatcher.execute(
      call("write_file", { path: "src/generated/x.ts", content: "x" }),
      ctx,
    );
    expect(generated.error?.code).toBe("denied_by_rule");

    // project allow matches before the broader global deny is relevant —
    // but deny is scanned first, so only non-matching denies let it through
    const denied = await dispatcher.execute(
      call("write_file", { path: "README.md", content: "x" }),
      ctx,
    );
    expect(denied.error?.code).toBe("denied_by_rule");
    expect(requests).toHaveLength(0);
  });

  it("project allow earlier in the array wins within the allow category", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const rules: PermissionRule[] = [
      { action: "allow", tool: "write_file", match: "docs/" }, // project
      { action: "allow", tool: "write_file", match: "docs/internal/" }, // global (redundant)
    ];
    const ctx = makeCtx(ws, { policy: { approvalMode: "confirm", rules }, confirm });
    const res = await dispatcher.execute(
      call("write_file", { path: "docs/internal/a.md", content: "x" }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("no rules → behavior identical to before (regression)", async () => {
    const ws = makeWorkspace();
    const withConfirm = scriptedConfirm(true);
    const emptyRulesCtx = makeCtx(ws, {
      policy: { approvalMode: "confirm", rules: [] },
      confirm: withConfirm.confirm,
    });
    const res = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "x" }),
      emptyRulesCtx,
    );
    expect(res.ok).toBe(true);
    expect(withConfirm.requests).toHaveLength(1); // still confirmed, as without rules
    expect(withConfirm.requests[0]?.permission).toBe("write");
  });
});

describe("approvalMode acceptEdits", () => {
  it("auto-allows in-workspace writes without prompting", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "acceptEdits" }, confirm });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("x");
  });

  it("still confirms L2 command execution (not auto-allowed)", async () => {
    const ws = makeWorkspace();
    const deny = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "acceptEdits" }, confirm: deny.confirm });
    const res = await dispatcher.execute(call("run_command", { command: "echo hi" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(deny.requests).toHaveLength(1);
    expect(deny.requests[0]?.permission).toBe("execute");
  });

  it("still confirms L3 env changes", async () => {
    const ws = makeWorkspace();
    const deny = scriptedConfirm(false);
    const ctx = makeCtx(ws, { policy: { approvalMode: "acceptEdits" }, confirm: deny.confirm });
    const res = await dispatcher.execute(
      call("run_command", { command: "pnpm install left-pad" }),
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(deny.requests[0]?.permission).toBe("env");
  });

  it("never rescues a dangerous command", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const ctx = makeCtx(ws, { policy: { approvalMode: "acceptEdits" }, confirm });
    const res = await dispatcher.execute(call("run_command", { command: "sudo rm -rf /" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(requests).toHaveLength(0);
  });

  it("still blocks writes in ask mode (deny stays authoritative)", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const ctx = makeCtx(ws, { policy: { mode: "ask", approvalMode: "acceptEdits" }, confirm });
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("forbidden_in_ask_mode");
    expect(requests).toHaveLength(0);
  });
});

describe("allow-for-session confirm channel", () => {
  it("boolean confirm contract still works (allow once / deny)", async () => {
    const ws = makeWorkspace();
    const allow = scriptedConfirm(true);
    const okRes = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "x" }),
      makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm: allow.confirm }),
    );
    expect(okRes.ok).toBe(true);

    const deny = scriptedConfirm(false);
    const denyRes = await dispatcher.execute(
      call("write_file", { path: "b.txt", content: "x" }),
      makeCtx(ws, { policy: { approvalMode: "confirm" }, confirm: deny.confirm }),
    );
    expect(denyRes.ok).toBe(false);
    expect(denyRes.error?.code).toBe("denied_by_user");
  });

  it("remember:session grows the command allowlist; a second matching call auto-allows", async () => {
    const ws = makeWorkspace();
    const sessionAllowlist: string[] = [];
    const { confirm, requests } = scriptedConfirm({ allow: true, remember: "session" });
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist },
      confirm,
    });

    // First call prompts and is remembered (command prefix pushed).
    const first = await dispatcher.execute(call("run_command", { command: "echo hi" }), ctx);
    expect(first.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(sessionAllowlist).toContain("echo hi");

    // Second matching call auto-allows WITHOUT prompting.
    const second = await dispatcher.execute(call("run_command", { command: "echo hi again" }), ctx);
    expect(second.ok).toBe(true);
    expect(requests).toHaveLength(1); // no new prompt
  });

  it("remember:session for a non-command tool remembers the tool name", async () => {
    const ws = makeWorkspace();
    const sessionAllowlist: string[] = [];
    const { confirm, requests } = scriptedConfirm({ allow: true, remember: "session" });
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist },
      confirm,
    });
    const first = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x" }), ctx);
    expect(first.ok).toBe(true);
    expect(sessionAllowlist).toContain("write_file");
    const second = await dispatcher.execute(call("write_file", { path: "b.txt", content: "y" }), ctx);
    expect(second.ok).toBe(true);
    expect(requests).toHaveLength(1); // only the first prompted
  });

  it("a different command still prompts (prefix match only)", async () => {
    const ws = makeWorkspace();
    const sessionAllowlist = ["echo hi"];
    const { confirm, requests } = scriptedConfirm(false);
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist },
      confirm,
    });
    const res = await dispatcher.execute(call("run_command", { command: "echo bye" }), ctx);
    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("remember is ignored when allow is false (no allowlist growth)", async () => {
    const ws = makeWorkspace();
    const sessionAllowlist: string[] = [];
    const { confirm } = scriptedConfirm({ allow: false, remember: "session" });
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist },
      confirm,
    });
    const res = await dispatcher.execute(call("run_command", { command: "echo hi" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
    expect(sessionAllowlist).toHaveLength(0);
  });

  it("session allowlist does NOT rescue a dangerous command", async () => {
    const ws = makeWorkspace();
    const { confirm, requests } = scriptedConfirm(true);
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm", sessionAllowlist: ["sudo rm"] },
      confirm,
    });
    const res = await dispatcher.execute(call("run_command", { command: "sudo rm -rf /" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(requests).toHaveLength(0);
  });
});

describe("dispatcher basics", () => {
  it("returns unknown_tool for unregistered tools", async () => {
    const res = await dispatcher.execute(call("nope", {}), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unknown_tool");
  });

  it("returns invalid_args with zod issues", async () => {
    const res = await dispatcher.execute(call("read_file", { path: 42 }), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
    expect(Array.isArray(res.error?.detail)).toBe(true);
  });

  it("logs one structured entry per call", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "hi");
    const entries: Record<string, unknown>[] = [];
    const ctx = makeCtx(ws, { log: (e) => entries.push(e) });
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect(entry.toolName).toBe("read_file");
    expect(entry.ok).toBe(true);
    expect(entry.errorCode).toBeNull();
    expect(entry.permissionDecision).toBe("auto_readonly");
    expect(typeof entry.durationMs).toBe("number");
    expect(typeof entry.startedAt).toBe("string");
    expect(typeof entry.endedAt).toBe("string");
  });

  it("advertises JSON Schemas for all built-in tools", () => {
    const defs = dispatcher.list();
    const names = defs.map((d) => d.name);
    expect(names).toEqual([
      "list_files",
      "read_file",
      "search_text",
      "write_file",
      "apply_patch",
      "glob",
      "run_command",
      "task_output",
      "task_kill",
      "git_status",
      "git_diff",
      "git_commit",
      "detect_project",
      "list_scripts",
      "update_plan",
      "web_fetch",
      "web_search",
      "ask_user",
      "image_analyze",
      "search_memory",
      "run_user_command",
      "repo_map",
      "find_definition",
    ]);
    const readFileDef = defs.find((d) => d.name === "read_file");
    expect(readFileDef?.parameters).toMatchObject({
      type: "object",
      required: ["path"],
    });
    const props = (readFileDef?.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.path).toMatchObject({ type: "string" });
    expect(props.offset).toMatchObject({ type: "number" });
  });
});

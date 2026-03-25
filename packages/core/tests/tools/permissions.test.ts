import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

function scriptedConfirm(answer: boolean): {
  confirm: (req: PermissionRequest) => Promise<boolean>;
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

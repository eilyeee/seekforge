import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { appendCheckpoint, rewindSession } from "../../src/agent/session-rewind.js";
import type { RuntimeClient } from "../../src/runtime/index.js";
import { createDefaultDispatcher, type ToolContext } from "../../src/tools/index.js";
import { isSensitiveNestedPath, resolveAdditionalDirectories, toolPathRoot } from "../../src/tools/sandbox.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

function setup(): { ws: string; extra: string; ctx: (overrides?: Partial<ToolContext>) => ToolContext } {
  const ws = makeWorkspace();
  const extra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-extra-")));
  fs.writeFileSync(path.join(extra, "notes.md"), "shared notes\n");
  return {
    ws,
    extra,
    ctx: (overrides = {}) => makeCtx(ws, { additionalDirectories: [extra], ...overrides }),
  };
}

describe("resolveAdditionalDirectories", () => {
  it("keeps existing directories outside the project, physically, and reports the rest", () => {
    const { ws, extra } = setup();
    const link = path.join(os.tmpdir(), `seekforge-extra-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(extra, link);
    fs.mkdirSync(path.join(ws, "inside"));
    const result = resolveAdditionalDirectories(
      [extra, link, path.join(ws, "inside"), path.join(extra, "notes.md"), "/definitely/missing", ""],
      ws,
    );
    expect(result.directories).toEqual([extra]);
    expect(result.rejected).toEqual([path.join(ws, "inside"), path.join(extra, "notes.md"), "/definitely/missing", ""]);
    fs.unlinkSync(link);
  });
});

describe("file tools in additional directories", () => {
  it("are refused outside the workspace when no directory was granted", async () => {
    const { ws, extra } = setup();
    const res = await dispatcher.execute(call("read_file", { path: path.join(extra, "notes.md") }), makeCtx(ws));
    expect(res.error?.code).toBe("outside_workspace");
  });

  it("read, list, search and glob inside a granted directory", async () => {
    const { extra, ctx } = setup();
    fs.mkdirSync(path.join(extra, "sub"));
    fs.writeFileSync(path.join(extra, "sub", "code.ts"), "export const answer = 42;\n");
    const read = await dispatcher.execute(call("read_file", { path: path.join(extra, "notes.md") }), ctx());
    expect(read.data).toMatchObject({ content: "shared notes\n" });
    const list = await dispatcher.execute(call("list_files", { path: extra }), ctx());
    expect((list.data as { entries: string[] }).entries).toEqual(["notes.md", "sub/", "sub/code.ts"]);
    const search = await dispatcher.execute(call("search_text", { pattern: "answer", path: extra }), ctx());
    expect((search.data as { matches: Array<{ file: string }> }).matches.map((m) => m.file)).toEqual(["sub/code.ts"]);
    const glob = await dispatcher.execute(call("glob", { pattern: "**/*.ts", path: extra }), ctx());
    expect((glob.data as { files: string[] }).files).toEqual(["sub/code.ts"]);
  });

  it("reach a granted directory through a relative path from the workspace", async () => {
    const { ws, extra, ctx } = setup();
    const relative = path.relative(fs.realpathSync(ws), path.join(extra, "notes.md"));
    const res = await dispatcher.execute(call("read_file", { path: relative }), ctx());
    expect(res.ok).toBe(true);
  });

  it("write and patch under the same prompts as the workspace, and acceptEdits applies", async () => {
    const { extra, ctx } = setup();
    const target = path.join(extra, "new", "file.txt");
    const prompts: PermissionRequest[] = [];
    const confirming = ctx({
      policy: { approvalMode: "confirm", mode: "edit", commandAllowlist: [] },
      confirm: async (req) => {
        prompts.push(req);
        return true;
      },
    });
    const written = await dispatcher.execute(call("write_file", { path: target, content: "one\n" }), confirming);
    expect(written.ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.path).toBe(target);
    expect(prompts[0]?.preview?.diff).toContain("+one");

    const acceptEdits = ctx({
      policy: { approvalMode: "acceptEdits", mode: "edit", commandAllowlist: [] },
      confirm: async () => {
        throw new Error("acceptEdits must not prompt for a write");
      },
    });
    const patched = await dispatcher.execute(
      call("apply_patch", { path: target, edits: [{ oldString: "one", newString: "two" }] }),
      acceptEdits,
    );
    expect(patched.ok).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("two\n");

    const askMode = ctx({ policy: { approvalMode: "auto", mode: "ask", commandAllowlist: [] } });
    const refused = await dispatcher.execute(
      call("write_file", { path: target, content: "x", overwrite: true }),
      askMode,
    );
    expect(refused.error?.code).toBe("forbidden_in_ask_mode");
  });

  it("apply notebook edits and image reads through the same routing", async () => {
    const { extra, ctx } = setup();
    const notebook = path.join(extra, "nb.ipynb");
    fs.writeFileSync(
      notebook,
      JSON.stringify({ cells: [{ cell_type: "code", source: ["print(1)"], metadata: {}, outputs: [] }], metadata: {} }),
    );
    const read = await dispatcher.execute(call("notebook_read", { path: notebook }), ctx());
    expect(read.ok).toBe(true);
    const edited = await dispatcher.execute(
      call("notebook_edit", { path: notebook, cellIndex: 0, mode: "replace", source: "print(2)" }),
      ctx(),
    );
    expect(edited.ok).toBe(true);
    expect(fs.readFileSync(notebook, "utf8")).toContain("print(2)");
  });

  it("refuse a symlink that leaves every granted root", async () => {
    const { extra, ctx } = setup();
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-elsewhere-")));
    fs.writeFileSync(path.join(elsewhere, "secret.txt"), "nope");
    fs.symlinkSync(elsewhere, path.join(extra, "escape"));
    const read = await dispatcher.execute(call("read_file", { path: path.join(extra, "escape", "secret.txt") }), ctx());
    expect(read.error?.code).toBe("outside_workspace");
    fs.symlinkSync(path.join(elsewhere, "missing.txt"), path.join(extra, "dangling.txt"));
    const write = await dispatcher.execute(
      call("write_file", { path: path.join(extra, "dangling.txt"), content: "x" }),
      ctx(),
    );
    expect(write.error?.code).toBe("outside_workspace");
    expect(fs.existsSync(path.join(elsewhere, "missing.txt"))).toBe(false);
  });

  it("keep secret files and .git unreachable at every depth", async () => {
    const { extra, ctx } = setup();
    const project = path.join(extra, "other-project");
    fs.mkdirSync(path.join(project, ".seekforge"), { recursive: true });
    fs.mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(project, ".seekforge", "config.json"), '{"apiKey":"sk-nested"}');
    fs.writeFileSync(path.join(project, ".git", "config"), "[remote]\n");
    fs.writeFileSync(path.join(project, ".env"), "TOKEN=1");
    for (const p of [".seekforge/config.json", ".git/config", ".env"]) {
      const res = await dispatcher.execute(call("read_file", { path: path.join(project, p) }), ctx());
      expect(res.error?.code, p).toBe("sensitive_path");
    }
    const hook = await dispatcher.execute(
      call("write_file", { path: path.join(project, ".git", "hooks", "pre-commit"), content: "#!/bin/sh\n" }),
      ctx(),
    );
    expect(hook.error?.code).toBe("sensitive_path");
    const search = await dispatcher.execute(call("search_text", { pattern: "sk-nested", path: extra }), ctx());
    expect((search.data as { count: number }).count).toBe(0);
  });

  it("leave the workspace's own rules in charge when a granted directory contains the workspace", async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-parent-")));
    const ws = path.join(parent, "project");
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(parent, "sibling.txt"), "hello");
    const ctx = makeCtx(ws, { additionalDirectories: [parent] });
    expect(toolPathRoot(ctx, ".git/config", "read")).toEqual({ root: ws, path: ".git/config" });
    const secret = await dispatcher.execute(call("read_file", { path: path.join(ws, ".git", "config") }), ctx);
    expect(secret.error?.code).toBe("sensitive_path");
    const write = await dispatcher.execute(call("write_file", { path: path.join(ws, ".git", "x"), content: "x" }), ctx);
    expect(write.error?.code).toBe("sensitive_path");
    const sibling = await dispatcher.execute(call("read_file", { path: "../sibling.txt" }), ctx);
    expect(sibling.ok).toBe(true);
  });

  it("pick the deepest granted root, so a nested project's secrets stay nested-root relative", () => {
    const { extra } = setup();
    const inner = path.join(extra, "inner");
    fs.mkdirSync(inner);
    const ctx = makeCtx(makeWorkspace(), { additionalDirectories: [extra, inner] });
    expect(toolPathRoot(ctx, path.join(inner, "a.txt"), "read")).toEqual({
      root: inner,
      path: path.join(inner, "a.txt"),
    });
  });

  it("route runtime-backed calls to the granted root", async () => {
    const { extra, ctx } = setup();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const runtime: RuntimeClient = {
      async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
        calls.push({ method, params });
        if (method === "read_file") return { content: "from runtime" } as T;
        if (method === "write_file") return { path: params.path } as T;
        if (method === "list_files") return { entries: [], truncated: false } as T;
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as RuntimeClient;
    const target = path.join(extra, "notes.md");
    await dispatcher.execute(call("read_file", { path: target }), ctx({ runtime }));
    await dispatcher.execute(call("list_files", { path: extra }), ctx({ runtime }));
    await dispatcher.execute(call("write_file", { path: target, content: "x", overwrite: true }), ctx({ runtime }));
    expect(calls.map((c) => [c.method, c.params.workspace, c.params.path])).toEqual([
      ["read_file", extra, target],
      ["list_files", extra, extra],
      ["read_file", extra, target],
      ["write_file", extra, target],
    ]);
    const workspaceCall = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx({ runtime }));
    expect(workspaceCall.ok).toBe(true);
    expect(calls.at(-1)?.params).toMatchObject({ path: "a.txt" });
    expect(calls.at(-1)?.params.workspace).not.toBe(extra);
  });

  it("record the absolute path for rewind, which then skips it instead of writing into the workspace", async () => {
    const { ws, extra, ctx } = setup();
    const checkpoints: Array<{ path: string; before: string | null }> = [];
    const target = path.join(extra, "notes.md");
    await dispatcher.execute(
      call("write_file", { path: target, content: "changed\n", overwrite: true }),
      ctx({ checkpoint: (p, before) => checkpoints.push({ path: p, before }) }),
    );
    expect(checkpoints).toEqual([{ path: target, before: "shared notes\n" }]);
    appendCheckpoint(ws, "sess-extra", { ts: new Date().toISOString(), path: target, before: "shared notes\n" });
    const result = rewindSession(ws, "sess-extra");
    expect(result.skipped).toEqual([{ path: target, reason: "path escapes the workspace" }]);
    expect(fs.readFileSync(target, "utf8")).toBe("changed\n");
  });
});

describe("search_text secret paths", () => {
  it("judges a secret by its place in the workspace, not by where the search starts", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, ".seekforge"));
    fs.writeFileSync(path.join(ws, ".seekforge", "config.json"), '{"apiKey":"sk-secret-123"}');
    for (const p of [".seekforge", ".seekforge/config.json", "."]) {
      const res = await dispatcher.execute(call("search_text", { pattern: "apiKey", path: p }), makeCtx(ws));
      expect((res.data as { count: number }).count, p).toBe(0);
    }
  });

  it("recognizes nested secret paths", () => {
    expect(isSensitiveNestedPath("pkg/.seekforge/config.json")).toBe(true);
    expect(isSensitiveNestedPath("a/b/.git/config")).toBe(true);
    expect(isSensitiveNestedPath(".git/config")).toBe(true);
    expect(isSensitiveNestedPath("a/config.json")).toBe(false);
    expect(isSensitiveNestedPath("git/config")).toBe(false);
  });
});

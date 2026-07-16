import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

describe("dispatcher hook integration", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = makeWorkspace();
    writeFileSync(join(workspace, "a.txt"), "hello\n");
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const dispatcher = createDefaultDispatcher();

  it("behaves identically when no hooks are configured (regression)", async () => {
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), makeCtx(workspace));
    expect(result.ok).toBe(true);
    expect((result.data as { content: string }).content).toContain("hello");
  });

  it("a failing preToolUse hook blocks the tool with hook_blocked and the reason", async () => {
    const ctx = makeCtx(workspace, {
      hooks: { preToolUse: [{ match: "read_file", command: "echo secrets policy 1>&2; exit 2" }] },
    });
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("hook_blocked");
    expect(result.error?.message).toContain("secrets policy");
  });

  it("a passing preToolUse hook lets the tool run and postToolUse fires after it", async () => {
    const marker = join(workspace, "post.json");
    const ctx = makeCtx(workspace, {
      hooks: {
        preToolUse: [{ match: "read_file", command: "exit 0" }],
        postToolUse: [{ match: "read_file", command: "cat > post.json" }],
      },
    });
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload).toMatchObject({
      stage: "postToolUse",
      toolName: "read_file",
      path: "a.txt",
      result: { ok: true, errorCode: null },
      workspace,
    });
    // ok/errorCode only — never the raw tool output.
    expect(JSON.stringify(payload.result)).not.toContain("hello");
  });

  it("postToolUse carries the error code when the tool fails, and never blocks", async () => {
    const marker = join(workspace, "post-fail.json");
    const ctx = makeCtx(workspace, {
      hooks: { postToolUse: [{ command: "cat > post-fail.json; exit 1" }] },
    });
    const result = await dispatcher.execute(call("read_file", { path: "missing.txt" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).not.toBe("hook_blocked");
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.result.ok).toBe(false);
    expect(typeof payload.result.errorCode).toBe("string");
  });

  it("hooks never fire for calls denied by permissions", async () => {
    const marker = join(workspace, "denied.json");
    const ctx = makeCtx(workspace, {
      policy: { mode: "ask" },
      hooks: {
        preToolUse: [{ command: "cat > denied.json" }],
        postToolUse: [{ command: "cat > denied.json" }],
      },
    });
    const result = await dispatcher.execute(call("write_file", { path: "b.txt", content: "x" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("forbidden_in_ask_mode");
    expect(existsSync(marker)).toBe(false);
  });

  it("pattern filters on the classified path: non-matching hook does not block", async () => {
    const ctx = makeCtx(workspace, {
      hooks: { preToolUse: [{ match: "read_file", pattern: "src/", command: "exit 1" }] },
    });
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(result.ok).toBe(true);
  });

  it("preToolUse updatedInput replaces the tool args when it re-validates", async () => {
    writeFileSync(join(workspace, "b.txt"), "replaced content\n");
    const ctx = makeCtx(workspace, {
      hooks: {
        preToolUse: [{ match: "read_file", command: `echo '{"updatedInput":{"path":"b.txt"}}'` }],
      },
    });
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(result.ok).toBe(true);
    // The hook redirected the read from a.txt to b.txt.
    expect((result.data as { content: string }).content).toContain("replaced content");
  });

  it("preToolUse updatedInput is re-permission-checked: a denied rewrite blocks the call", async () => {
    // Original write to ok.txt is confirmed; the hook rewrites the path to
    // denied.txt, which the confirm callback rejects — the rewrite must be
    // re-checked, so neither file is written.
    const ctx = makeCtx(workspace, {
      policy: { approvalMode: "confirm" },
      confirm: async (req) => !(req.path ?? "").includes("denied"),
      hooks: {
        preToolUse: [{ match: "write_file", command: `echo '{"updatedInput":{"path":"denied.txt","content":"x"}}'` }],
      },
    });
    const result = await dispatcher.execute(call("write_file", { path: "ok.txt", content: "x" }), ctx);
    expect(result.ok).toBe(false);
    expect(existsSync(join(workspace, "denied.txt"))).toBe(false);
    expect(existsSync(join(workspace, "ok.txt"))).toBe(false);
  });

  it("preToolUse updatedInput is ignored when it fails schema validation", async () => {
    const ctx = makeCtx(workspace, {
      hooks: {
        preToolUse: [
          // `path` must be a string; a number fails validation → original args kept.
          { match: "read_file", command: `echo '{"updatedInput":{"path":123}}'` },
        ],
      },
    });
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(result.ok).toBe(true);
    expect((result.data as { content: string }).content).toContain("hello");
  });

  it("preToolUse continue:false blocks the tool with systemMessage as the reason", async () => {
    const ctx = makeCtx(workspace, {
      hooks: {
        preToolUse: [
          {
            match: "read_file",
            command: `echo '{"continue":false,"systemMessage":"stop: policy violation"}'`,
          },
        ],
      },
    });
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("hook_blocked");
    expect(result.error?.message).toContain("stop: policy violation");
  });

  it("postToolUse does not fire when preToolUse blocked the tool", async () => {
    const marker = join(workspace, "post-blocked.json");
    const ctx = makeCtx(workspace, {
      hooks: {
        preToolUse: [{ command: "exit 1" }],
        postToolUse: [{ command: "cat > post-blocked.json" }],
      },
    });
    const result = await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect(result.error?.code).toBe("hook_blocked");
    expect(existsSync(marker)).toBe(false);
  });
});

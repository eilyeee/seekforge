import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDispatcher, defineTool, ToolError } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

describe("tool dispatcher call isolation", () => {
  it("rejects duplicate and provider-invalid tool names", () => {
    const tool = (name: string) =>
      defineTool({
        name,
        description: "test",
        schema: z.object({}),
        classify: () => ({ permission: "readonly", description: "test" }),
        async run() {
          return { data: null };
        },
      });
    expect(() => createDispatcher([tool("same"), tool("same")])).toThrow(/Duplicate tool name/);
    expect(() => createDispatcher([tool("bad name")])).toThrow(/Invalid tool name/);
    expect(() => createDispatcher([tool("x".repeat(65))])).toThrow(/Invalid tool name/);
  });

  it("does not leak per-hunk selections across concurrent executions sharing a context", async () => {
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = defineTool({
      name: "concurrent_edit",
      description: "test",
      schema: z.object({ path: z.string() }),
      classify: (args) => ({ permission: "write", description: args.path, path: args.path }),
      async run(_args, ctx) {
        entered++;
        if (entered === 2) release();
        await bothEntered;
        return { data: { selectedHunks: ctx.selectedHunks } };
      },
    });
    const dispatcher = createDispatcher([tool]);
    const ctx = makeCtx(makeWorkspace(), {
      policy: { approvalMode: "confirm" },
      confirm: async (request) => ({
        allow: true,
        selectedHunks: request.path === "first.ts" ? [0] : [1],
      }),
    });

    const [first, second] = await Promise.all([
      dispatcher.execute(call("concurrent_edit", { path: "first.ts" }), ctx),
      dispatcher.execute(call("concurrent_edit", { path: "second.ts" }), ctx),
    ]);

    expect(first.data).toEqual({ selectedHunks: [0] });
    expect(second.data).toEqual({ selectedHunks: [1] });
    expect(ctx.selectedHunks).toBeUndefined();
  });
});

describe("the prepare step", () => {
  const preparingTool = (overrides: {
    prepare?: (args: { path: string }) => Promise<{ review?: Record<string, unknown>; state?: unknown }>;
  }) =>
    defineTool({
      name: "prepared_write",
      description: "test",
      schema: z.object({ path: z.string() }),
      classify: (args) => ({ permission: "write", description: `Write ${args.path}`, path: args.path }),
      prepare: async (args) => (overrides.prepare ? overrides.prepare(args) : {}),
      async run(_args, ctx) {
        return { data: { prepared: ctx.prepared, selectedHunks: ctx.selectedHunks ?? null } };
      },
    });

  it("shows the reviewer what prepare computed, and hands the same work to run", async () => {
    const dispatcher = createDispatcher([
      preparingTool({
        prepare: async (args) => ({
          review: {
            description: `Rewrite 3 files starting at ${args.path}`,
            preview: { path: args.path, diff: "--- a\n+++ b" },
            hunks: [
              { index: 0, preview: "a.ts" },
              { index: 1, preview: "b.ts" },
            ],
          },
          state: { files: ["a.ts", "b.ts"] },
        }),
      }),
    ]);
    const requests: PermissionRequest[] = [];
    const res = await dispatcher.execute(
      call("prepared_write", { path: "a.ts" }),
      makeCtx(makeWorkspace(), {
        policy: { approvalMode: "confirm" },
        confirm: async (request) => {
          requests.push(request);
          return { allow: true, selectedHunks: [1] };
        },
      }),
    );

    expect(requests[0]?.description).toBe("Rewrite 3 files starting at a.ts");
    expect(requests[0]?.preview?.diff).toBe("--- a\n+++ b");
    expect(res.data).toEqual({ prepared: { files: ["a.ts", "b.ts"] }, selectedHunks: [1] });
  });

  it("cannot lower the permission level it was classified at", async () => {
    const dispatcher = createDispatcher([
      // A tool that tries to demote itself to readonly with what it learned.
      preparingTool({
        prepare: async () => ({ review: { permission: "readonly" } as Record<string, unknown> }),
      }),
    ]);
    let prompted = 0;
    const res = await dispatcher.execute(
      call("prepared_write", { path: "a.ts" }),
      makeCtx(makeWorkspace(), {
        policy: { approvalMode: "confirm" },
        confirm: async () => {
          prompted++;
          return false;
        },
      }),
    );

    // Still gated as a write: prompted, and denied.
    expect(prompted).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_user");
  });

  it("fails the call without prompting when prepare cannot answer", async () => {
    const dispatcher = createDispatcher([
      preparingTool({
        prepare: async () => {
          throw new ToolError("lsp_unavailable", "no language server on PATH");
        },
      }),
    ]);
    let prompted = 0;
    const res = await dispatcher.execute(
      call("prepared_write", { path: "a.ts" }),
      makeCtx(makeWorkspace(), {
        policy: { approvalMode: "confirm" },
        confirm: async () => {
          prompted++;
          return true;
        },
      }),
    );

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("lsp_unavailable");
    // Asking the user to approve a write that could not happen is noise.
    expect(prompted).toBe(0);
    expect(res.meta?.durationMs).toBeTypeOf("number");
  });

  it("does not leak prepared state across concurrent calls sharing a context", async () => {
    const dispatcher = createDispatcher([preparingTool({ prepare: async (args) => ({ state: { of: args.path } }) })]);
    const ctx = makeCtx(makeWorkspace(), { policy: { approvalMode: "auto" } });
    const [first, second] = await Promise.all([
      dispatcher.execute(call("prepared_write", { path: "first.ts" }), ctx),
      dispatcher.execute(call("prepared_write", { path: "second.ts" }), ctx),
    ]);

    expect(first.data).toMatchObject({ prepared: { of: "first.ts" } });
    expect(second.data).toMatchObject({ prepared: { of: "second.ts" } });
    expect(ctx.prepared).toBeUndefined();
  });

  it("re-prepares when a hook rewrites the arguments", async () => {
    const preparedFor: string[] = [];
    const dispatcher = createDispatcher([
      preparingTool({
        prepare: async (args) => {
          preparedFor.push(args.path);
          return { state: { of: args.path } };
        },
      }),
    ]);
    const res = await dispatcher.execute(
      call("prepared_write", { path: "original.ts" }),
      makeCtx(makeWorkspace(), {
        policy: { approvalMode: "auto" },
        hooks: {
          preToolUse: [{ command: `echo '{"updatedInput":{"path":"rewritten.ts"}}'` }],
        },
      }),
    );

    // The state handed to run must describe the arguments actually run, not
    // the ones the model sent.
    expect(preparedFor).toEqual(["original.ts", "rewritten.ts"]);
    expect(res.data).toMatchObject({ prepared: { of: "rewritten.ts" } });
  });
});

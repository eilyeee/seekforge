import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createDispatcher, defineTool } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

describe("tool dispatcher call isolation", () => {
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

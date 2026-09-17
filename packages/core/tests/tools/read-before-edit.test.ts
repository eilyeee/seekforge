import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher, createFileLedger, ToolError, type ToolContext } from "../../src/tools/index.js";
import { parseFileLedger, serializeFileLedger, stampFor } from "../../src/tools/file-ledger.js";
import type { RuntimeClient } from "../../src/runtime/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

function setup(content = "alpha\nbeta\n"): { ws: string; file: string; ctx: ToolContext } {
  const ws = makeWorkspace();
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, content);
  return { ws, file, ctx: makeCtx(ws, { fileLedger: createFileLedger() }) };
}

const patch = (oldString: string, newString: string) =>
  call("apply_patch", { path: "a.txt", edits: [{ oldString, newString }] });

describe("read-before-edit guard", () => {
  it("refuses to patch an existing file that was not read", async () => {
    const { file, ctx } = setup();
    const res = await dispatcher.execute(patch("alpha", "ALPHA"), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("file_not_read");
    expect(res.error?.message).toContain("read_file");
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\nbeta\n");
  });

  it("refuses to overwrite an existing file that was not read", async () => {
    const { file, ctx } = setup();
    const res = await dispatcher.execute(call("write_file", { path: "a.txt", content: "x", overwrite: true }), ctx);
    expect(res.error?.code).toBe("file_not_read");
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\nbeta\n");
  });

  it("allows the edit after a read, including a partial one", async () => {
    const { file, ctx } = setup();
    await dispatcher.execute(call("read_file", { path: "a.txt", offset: 2, limit: 1 }), ctx);
    const res = await dispatcher.execute(patch("alpha", "ALPHA"), ctx);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("ALPHA\nbeta\n");
  });

  it("lets the model keep editing what it wrote itself", async () => {
    const { ws, ctx } = setup();
    expect((await dispatcher.execute(call("write_file", { path: "new.txt", content: "one\n" }), ctx)).ok).toBe(true);
    const edit = await dispatcher.execute(
      call("apply_patch", { path: "new.txt", edits: [{ oldString: "one", newString: "two" }] }),
      ctx,
    );
    expect(edit.ok).toBe(true);
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    await dispatcher.execute(patch("alpha", "ALPHA"), ctx);
    expect((await dispatcher.execute(patch("beta", "BETA"), ctx)).ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("ALPHA\nBETA\n");
  });

  it("refuses an edit after the file changed on disk, until it is re-read", async () => {
    const { file, ctx } = setup();
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    fs.writeFileSync(file, "alpha\nbeta\ngamma\n");
    const stale = await dispatcher.execute(patch("alpha", "ALPHA"), ctx);
    expect(stale.error?.code).toBe("file_changed");
    expect(stale.error?.message).toContain("Re-read");
    const overwrite = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "x", overwrite: true }),
      ctx,
    );
    expect(overwrite.error?.code).toBe("file_changed");

    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect((await dispatcher.execute(patch("alpha", "ALPHA"), ctx)).ok).toBe(true);
  });

  it("does not count a rewrite with identical content as a change", async () => {
    const { file, ctx } = setup();
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(file, "alpha\nbeta\n");
    fs.utimesSync(file, later, later);
    expect(
      (await dispatcher.execute(call("write_file", { path: "a.txt", content: "x", overwrite: true }), ctx)).ok,
    ).toBe(true);
  });

  it("counts reading an image as reading it", async () => {
    const { ws, ctx } = setup();
    fs.writeFileSync(path.join(ws, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
    const blind = await dispatcher.execute(
      call("write_file", { path: "logo.png", content: "x", overwrite: true }),
      ctx,
    );
    expect(blind.error?.code).toBe("file_not_read");
    expect((await dispatcher.execute(call("read_file", { path: "logo.png" }), ctx)).ok).toBe(true);
    const res = await dispatcher.execute(call("write_file", { path: "logo.png", content: "x", overwrite: true }), ctx);
    expect(res.ok).toBe(true);
  });

  it("creating a new file needs no read", async () => {
    const { ws, ctx } = setup();
    const res = await dispatcher.execute(
      call("write_file", { path: "fresh/b.txt", content: "b", overwrite: true }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "fresh", "b.txt"), "utf8")).toBe("b");
  });

  it("refuses before asking the user, so nobody approves a write that cannot happen", async () => {
    const { ws } = setup();
    const asked: PermissionRequest[] = [];
    const ctx = makeCtx(ws, {
      fileLedger: createFileLedger(),
      policy: { approvalMode: "confirm" },
      confirm: async (req) => {
        asked.push(req);
        return true;
      },
    });
    const res = await dispatcher.execute(patch("alpha", "ALPHA"), ctx);
    expect(res.error?.code).toBe("file_not_read");
    expect(asked).toEqual([]);
  });

  it("re-checks at run time when the file changes while the user decides", async () => {
    const { file, ws } = setup();
    const ledger = createFileLedger();
    const ctx = makeCtx(ws, {
      fileLedger: ledger,
      policy: { approvalMode: "confirm" },
      confirm: async () => {
        fs.writeFileSync(file, "alpha\nbeta\nedited by the user\n");
        return true;
      },
    });
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    const res = await dispatcher.execute(patch("alpha", "ALPHA"), ctx);
    expect(res.error?.code).toBe("file_changed");
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\nbeta\nedited by the user\n");
  });

  it("requires a re-read after the user approved only some hunks", async () => {
    const { file, ws } = setup();
    const ctx = makeCtx(ws, {
      fileLedger: createFileLedger(),
      policy: { approvalMode: "confirm" },
      confirm: async (): Promise<ConfirmResult> => ({ allow: true, selectedHunks: [0] }),
    });
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    const res = await dispatcher.execute(
      call("apply_patch", {
        path: "a.txt",
        edits: [
          { oldString: "alpha", newString: "ALPHA" },
          { oldString: "beta", newString: "BETA" },
        ],
      }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect((res.data as { note?: string }).note).toContain("Re-read");
    expect(fs.readFileSync(file, "utf8")).toBe("ALPHA\nbeta\n");
    const next = await dispatcher.execute(
      call("apply_patch", { path: "a.txt", edits: [{ oldString: "ALPHA", newString: "A" }] }),
      makeCtx(ws, { fileLedger: ctx.fileLedger }),
    );
    expect(next.error?.code).toBe("file_not_read");
  });

  it("keeps the old behavior for a context without a ledger", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "alpha\n");
    const res = await dispatcher.execute(patch("alpha", "ALPHA"), makeCtx(ws));
    expect(res.ok).toBe(true);
  });
});

describe("read-before-edit guard through the runtime backend", () => {
  function runtimeWith(files: Record<string, string>): RuntimeClient {
    return {
      async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
        const p = String(params.path);
        if (method === "read_file") {
          if (files[p] === undefined) throw new ToolError("not_found", p);
          return { content: files[p] } as T;
        }
        if (method === "write_file") {
          files[p] = String(params.content);
          return { path: p } as T;
        }
        if (method === "apply_patch") {
          const edits = params.edits as Array<{ oldString: string; newString: string }>;
          let next = files[p] ?? "";
          for (const e of edits) next = next.replace(e.oldString, e.newString);
          files[p] = next;
          return { path: p, editsApplied: edits.length } as T;
        }
        throw new ToolError("unsupported", method);
      },
      async ping() {
        return { version: "fake" };
      },
      dispose() {},
    };
  }

  it("guards by content hash when there is no local stat", async () => {
    const files: Record<string, string> = { "a.txt": "alpha\n" };
    const ctx = makeCtx(makeWorkspace(), { runtime: runtimeWith(files), fileLedger: createFileLedger() });
    expect((await dispatcher.execute(patch("alpha", "ALPHA"), ctx)).error?.code).toBe("file_not_read");
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    expect((await dispatcher.execute(patch("alpha", "ALPHA"), ctx)).ok).toBe(true);
    // The runtime's own result is reproduced, so a follow-up edit needs no re-read...
    expect((await dispatcher.execute(patch("ALPHA", "A"), ctx)).ok).toBe(true);
    // ...but an outside change does.
    files["a.txt"] = "changed\n";
    expect((await dispatcher.execute(patch("changed", "C"), ctx)).error?.code).toBe("file_changed");
  });

  it("applies replaceAll locally and writes the whole file back", async () => {
    const files: Record<string, string> = { "a.txt": "x = x + x\n" };
    const ctx = makeCtx(makeWorkspace(), { runtime: runtimeWith(files), fileLedger: createFileLedger() });
    await dispatcher.execute(call("read_file", { path: "a.txt" }), ctx);
    const res = await dispatcher.execute(
      call("apply_patch", { path: "a.txt", edits: [{ oldString: "x", newString: "y", replaceAll: true }] }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(files["a.txt"]).toBe("y = y + y\n");
  });
});

describe("ledger persistence format", () => {
  it("round-trips stamps and drops malformed entries", () => {
    const ledger = createFileLedger();
    ledger.set("/w/a.txt", stampFor("a", { mtimeMs: 1.5, size: 1 }));
    ledger.set("runtime:/w/b.txt", stampFor("b"));
    const restored = parseFileLedger(serializeFileLedger(ledger));
    expect(restored.entries()).toEqual(ledger.entries());

    const hostile = JSON.stringify({
      version: 1,
      files: {
        good: { hash: "a".repeat(64) },
        shortHash: { hash: "abc" },
        halfStat: { hash: "b".repeat(64), mtimeMs: 1 },
        negative: { hash: "c".repeat(64), mtimeMs: -1, size: 1 },
        notObject: "x",
      },
    });
    expect(
      parseFileLedger(hostile)
        .entries()
        .map(([key]) => key),
    ).toEqual(["good"]);
    expect(parseFileLedger("{not json").entries()).toEqual([]);
    expect(parseFileLedger(JSON.stringify({ version: 2, files: {} })).entries()).toEqual([]);
  });
});

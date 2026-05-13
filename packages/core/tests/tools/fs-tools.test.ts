import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

describe("write_file", () => {
  it("creates a file with parent directories", async () => {
    const ws = makeWorkspace();
    const res = await dispatcher.execute(
      call("write_file", { path: "deep/dir/a.txt", content: "hello" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "deep/dir/a.txt"), "utf8")).toBe("hello");
  });

  it("fails with 'exists' when the file exists and overwrite is not set", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "old");
    const res = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "new" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("exists");
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("old");
  });

  it("overwrites when overwrite is true", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "old");
    const res = await dispatcher.execute(
      call("write_file", { path: "a.txt", content: "new", overwrite: true }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("new");
  });
});

describe("search_text", () => {
  function setup(): string {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "node_modules/dep"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/a.ts"), "const needle = 1;\nconst other = 2;\n");
    fs.writeFileSync(path.join(ws, "node_modules/dep/b.ts"), "const needle = 99;\n");
    return ws;
  }

  it("finds matches with file/line/text", async () => {
    const ws = setup();
    const res = await dispatcher.execute(call("search_text", { pattern: "needle" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { matches: Array<{ file: string; line: number; text: string }> };
    expect(data.matches).toEqual([
      { file: "src/a.ts", line: 1, text: "const needle = 1;" },
    ]);
  });

  it("respects the default ignore list", async () => {
    const ws = setup();
    const res = await dispatcher.execute(call("search_text", { pattern: "needle" }), makeCtx(ws));
    const data = res.data as { matches: Array<{ file: string }> };
    expect(data.matches.every((m) => !m.file.includes("node_modules"))).toBe(true);
  });

  it("skips binary files", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "bin.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    const res = await dispatcher.execute(call("search_text", { pattern: "needle" }), makeCtx(ws));
    const data = res.data as { matches: unknown[] };
    expect(data.matches).toEqual([]);
  });
});

describe("list_files", () => {
  it("lists recursively, sorted, honoring the ignore list", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/b.ts"), "");
    fs.writeFileSync(path.join(ws, "src/a.ts"), "");
    fs.writeFileSync(path.join(ws, "README.md"), "");
    const res = await dispatcher.execute(call("list_files", {}), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { entries: string[] };
    expect(data.entries).toEqual(["README.md", "src/", "src/a.ts", "src/b.ts"]);
  });
});

describe("read_file", () => {
  it("reads a line range", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "f.txt"), "l1\nl2\nl3\nl4\n");
    const res = await dispatcher.execute(
      call("read_file", { path: "f.txt", offset: 2, limit: 2 }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    expect((res.data as { content: string }).content).toBe("l2\nl3");
  });

  it("denies sensitive files", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
    const res = await dispatcher.execute(call("read_file", { path: ".env" }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("sensitive_path");
  });
});

describe("edit-review preview (write tools)", () => {
  // Capture the PermissionRequest the dispatcher hands to confirm(): set
  // approvalMode "confirm" so write tools prompt, and approve so the write
  // still happens. This exercises the full classify → confirmWithUser seam.
  async function captureRequest(
    ws: string,
    name: string,
    args: unknown,
  ): Promise<{ ok: boolean; preview?: { path: string; diff: string } }> {
    let preview: { path: string; diff: string } | undefined;
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm" },
      confirm: async (req) => {
        preview = req.preview;
        return true;
      },
    });
    const res = await dispatcher.execute(call(name, args), ctx);
    return { ok: res.ok, preview };
  }

  it("write_file attaches a current→proposed diff when overwriting", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "line1\nline2\n");
    const { ok, preview } = await captureRequest(ws, "write_file", {
      path: "a.txt",
      content: "line1\nCHANGED\n",
      overwrite: true,
    });
    expect(ok).toBe(true);
    expect(preview?.path).toBe("a.txt");
    expect(preview?.diff).toContain("--- a/a.txt");
    expect(preview?.diff).toContain("+++ b/a.txt");
    expect(preview?.diff).toContain("-line2");
    expect(preview?.diff).toContain("+CHANGED");
    expect(preview?.diff).toContain(" line1"); // unchanged context line
  });

  it("write_file diff treats a new file as a creation (no current content)", async () => {
    const ws = makeWorkspace();
    const { ok, preview } = await captureRequest(ws, "write_file", {
      path: "new.txt",
      content: "hello\nworld\n",
    });
    expect(ok).toBe(true);
    expect(preview?.diff).toContain("+hello");
    expect(preview?.diff).toContain("+world");
    // No deletion body lines (the "--- a/" header line is metadata, not a del).
    const delBody = preview!.diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(delBody).toHaveLength(0);
  });

  it("apply_patch attaches a diff of the applied edits", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "alpha\nbeta\ngamma\n");
    const { ok, preview } = await captureRequest(ws, "apply_patch", {
      path: "a.txt",
      edits: [{ oldString: "beta", newString: "BETA" }],
    });
    expect(ok).toBe(true);
    expect(preview?.path).toBe("a.txt");
    expect(preview?.diff).toContain("-beta");
    expect(preview?.diff).toContain("+BETA");
  });

  it("omits the preview when apply_patch targets a missing file (graceful)", async () => {
    const ws = makeWorkspace();
    let sawRequest = false;
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "confirm" },
      confirm: async (req) => {
        sawRequest = true;
        expect(req.preview).toBeUndefined();
        return true;
      },
    });
    const res = await dispatcher.execute(
      call("apply_patch", { path: "missing.txt", edits: [{ oldString: "x", newString: "y" }] }),
      ctx,
    );
    expect(sawRequest).toBe(true);
    // The run itself then fails because the file does not exist.
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
  });

  it("omits the preview when an apply_patch edit does not match (graceful)", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "alpha\n");
    const { preview } = await captureRequest(ws, "apply_patch", {
      path: "a.txt",
      edits: [{ oldString: "does-not-exist", newString: "z" }],
    });
    expect(preview).toBeUndefined();
  });

  it("truncates very large diffs with a marker", async () => {
    const ws = makeWorkspace();
    const big = Array.from({ length: 1000 }, (_, i) => `old-${i}`).join("\n") + "\n";
    fs.writeFileSync(path.join(ws, "big.txt"), big);
    const next = Array.from({ length: 1000 }, (_, i) => `new-${i}`).join("\n") + "\n";
    const { preview } = await captureRequest(ws, "write_file", {
      path: "big.txt",
      content: next,
      overwrite: true,
    });
    expect(preview).toBeDefined();
    expect(preview?.diff).toContain("more lines truncated");
    // Body capped at 400 lines + header(2) + marker; comfortably under 2000.
    expect(preview!.diff.split("\n").length).toBeLessThan(420);
  });
});

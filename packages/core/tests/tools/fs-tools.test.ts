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

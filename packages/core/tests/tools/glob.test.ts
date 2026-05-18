import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { compileGlob, globToRegExpSource } from "../../src/tools/builtins/glob.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

describe("glob compiler", () => {
  const m = (pattern: string, p: string): boolean => compileGlob(pattern).test(p);

  it("* matches within a segment but does not cross /", () => {
    expect(m("*.ts", "a.ts")).toBe(true);
    expect(m("*.ts", "src/a.ts")).toBe(false);
    expect(m("src/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/*.ts", "src/sub/a.ts")).toBe(false);
  });

  it("** crosses directories", () => {
    expect(m("**/*.ts", "a.ts")).toBe(true); // zero dirs
    expect(m("**/*.ts", "src/a.ts")).toBe(true);
    expect(m("**/*.ts", "src/deep/nested/a.ts")).toBe(true);
    expect(m("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(m("src/**/*.ts", "other/a.ts")).toBe(false);
  });

  it("? matches a single non-slash char", () => {
    expect(m("a?c.ts", "abc.ts")).toBe(true);
    expect(m("a?c.ts", "ac.ts")).toBe(false);
    expect(m("a?c", "a/c")).toBe(false);
  });

  it("{a,b} alternation", () => {
    expect(m("*.{ts,tsx}", "a.ts")).toBe(true);
    expect(m("*.{ts,tsx}", "a.tsx")).toBe(true);
    expect(m("*.{ts,tsx}", "a.js")).toBe(false);
    expect(m("src/**/*.{ts,tsx}", "src/x/y.tsx")).toBe(true);
  });

  it("[...] character classes including negation", () => {
    expect(m("file[0-9].ts", "file3.ts")).toBe(true);
    expect(m("file[0-9].ts", "filex.ts")).toBe(false);
    expect(m("file[!0-9].ts", "filex.ts")).toBe(true);
    expect(m("file[!0-9].ts", "file3.ts")).toBe(false);
  });

  it("escapes regex-special literal chars", () => {
    expect(m("a.b.ts", "a.b.ts")).toBe(true);
    expect(m("a.b.ts", "aXbXts")).toBe(false);
    expect(globToRegExpSource("a+b")).toContain("\\+");
  });

  it("normalizes a leading ./", () => {
    expect(m("./src/*.ts", "src/a.ts")).toBe(true);
  });
});

describe("glob tool", () => {
  it("returns workspace-relative matches", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src/a.ts"), "");
    fs.writeFileSync(path.join(ws, "src/b.tsx"), "");
    fs.writeFileSync(path.join(ws, "README.md"), "");
    const res = await dispatcher.execute(call("glob", { pattern: "src/**/*.{ts,tsx}" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    const data = res.data as { files: string[] };
    expect([...data.files].sort()).toEqual(["src/a.ts", "src/b.tsx"]);
  });

  it("sorts by mtime descending (newest first)", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "old.ts"), "");
    fs.writeFileSync(path.join(ws, "new.ts"), "");
    // Force distinct mtimes regardless of fs resolution.
    fs.utimesSync(path.join(ws, "old.ts"), new Date(1000), new Date(1000));
    fs.utimesSync(path.join(ws, "new.ts"), new Date(2000), new Date(2000));
    const res = await dispatcher.execute(call("glob", { pattern: "*.ts" }), makeCtx(ws));
    const data = res.data as { files: string[] };
    expect(data.files).toEqual(["new.ts", "old.ts"]);
  });

  it("skips ignored and dot directories", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "node_modules/dep"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(ws, "node_modules/dep/x.ts"), "");
    fs.writeFileSync(path.join(ws, ".hidden/y.ts"), "");
    fs.writeFileSync(path.join(ws, "z.ts"), "");
    const res = await dispatcher.execute(call("glob", { pattern: "**/*.ts" }), makeCtx(ws));
    const data = res.data as { files: string[] };
    expect(data.files).toEqual(["z.ts"]);
  });

  it("honors a base path", async () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, "src"));
    fs.mkdirSync(path.join(ws, "other"));
    fs.writeFileSync(path.join(ws, "src/a.ts"), "");
    fs.writeFileSync(path.join(ws, "other/b.ts"), "");
    const res = await dispatcher.execute(call("glob", { pattern: "*.ts", path: "src" }), makeCtx(ws));
    const data = res.data as { files: string[] };
    // Paths are relative to the base dir.
    expect(data.files).toEqual(["a.ts"]);
  });

  it("caps results and flags truncation", async () => {
    const ws = makeWorkspace();
    for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(ws, `f${i}.ts`), "");
    const res = await dispatcher.execute(call("glob", { pattern: "*.ts" }), makeCtx(ws));
    const data = res.data as { files: string[]; truncated: boolean };
    expect(data.files.length).toBe(1000);
    expect(data.truncated).toBe(true);
  });
});

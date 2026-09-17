import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher, ToolError } from "../../src/tools/index.js";
import type { RuntimeClient } from "../../src/runtime/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

function repo(): string {
  const ws = makeWorkspace();
  const files: Record<string, string> = {
    ".gitignore": "generated/\n*.log\n!important.log\n",
    "src/app.ts": "const needle = 1;\n",
    "src/debug.log": "needle in a log\n",
    "src/important.log": "needle kept\n",
    "generated/out.ts": "const needle = 2;\n",
    "pkg/.gitignore": "fixtures/\n",
    "pkg/fixtures/data.ts": "const needle = 3;\n",
    "pkg/index.ts": "const needle = 4;\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content);
  }
  fs.mkdirSync(path.join(ws, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "dep", "index.ts"), "const needle = 5;\n");
  return ws;
}

async function run(ws: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await dispatcher.execute(call(name, args), makeCtx(ws));
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return res.data as Record<string, unknown>;
}

describe("walking tools respect .gitignore", () => {
  it("list_files skips ignored entries and subtrees", async () => {
    const ws = repo();
    const data = await run(ws, "list_files", {});
    expect(data.entries).toEqual([
      ".gitignore",
      "pkg/",
      "pkg/.gitignore",
      "pkg/index.ts",
      "src/",
      "src/app.ts",
      "src/important.log",
    ]);
  });

  it("list_files includes ignored entries on request, but never the fixed floor", async () => {
    const ws = repo();
    const data = await run(ws, "list_files", { includeIgnored: true });
    const entries = data.entries as string[];
    expect(entries).toContain("generated/out.ts");
    expect(entries).toContain("src/debug.log");
    expect(entries).toContain("pkg/fixtures/data.ts");
    expect(entries.some((e) => e.startsWith("node_modules"))).toBe(false);
  });

  it("list_files lists inside an ignored directory named as path", async () => {
    const ws = repo();
    const data = await run(ws, "list_files", { path: "generated" });
    expect(data.entries).toEqual(["out.ts"]);
  });

  it("search_text skips ignored files unless includeIgnored", async () => {
    const ws = repo();
    const plain = await run(ws, "search_text", { pattern: "needle", filesWithMatches: true });
    expect(plain.files).toEqual(["pkg/index.ts", "src/app.ts", "src/important.log"]);
    const all = await run(ws, "search_text", { pattern: "needle", filesWithMatches: true, includeIgnored: true });
    expect(all.files).toEqual([
      "generated/out.ts",
      "pkg/fixtures/data.ts",
      "pkg/index.ts",
      "src/app.ts",
      "src/debug.log",
      "src/important.log",
    ]);
  });

  it("search_text applies nested rules relative to a subdirectory root", async () => {
    const ws = repo();
    const data = await run(ws, "search_text", { pattern: "needle", path: "pkg", filesWithMatches: true });
    expect(data.files).toEqual(["index.ts"]);
    const inside = await run(ws, "search_text", { pattern: "needle", path: "pkg/fixtures", filesWithMatches: true });
    expect(inside.files).toEqual(["data.ts"]);
  });

  it("search_text still searches an ignored file named as path", async () => {
    const ws = repo();
    const data = await run(ws, "search_text", { pattern: "needle", path: "src/debug.log" });
    expect((data.matches as unknown[]).length).toBe(1);
  });

  it("glob skips ignored matches unless includeIgnored", async () => {
    const ws = repo();
    const plain = await run(ws, "glob", { pattern: "**/*.ts" });
    expect([...(plain.files as string[])].sort()).toEqual(["pkg/index.ts", "src/app.ts"]);
    const all = await run(ws, "glob", { pattern: "**/*.ts", includeIgnored: true });
    expect([...(all.files as string[])].sort()).toEqual([
      "generated/out.ts",
      "pkg/fixtures/data.ts",
      "pkg/index.ts",
      "src/app.ts",
    ]);
  });

  it("filters a runtime backend's listing through the same rules", async () => {
    const ws = repo();
    const runtime: RuntimeClient = {
      async call<T>(method: string): Promise<T> {
        if (method !== "list_files") throw new ToolError("unsupported", method);
        return {
          entries: [
            "generated/",
            "generated/out.ts",
            "pkg/",
            "pkg/fixtures/",
            "pkg/fixtures/data.ts",
            "src/",
            "src/app.ts",
            "src/debug.log",
          ],
          truncated: false,
        } as T;
      },
      async ping() {
        return { version: "fake" };
      },
      dispose() {},
    };
    const res = await dispatcher.execute(call("list_files", {}), makeCtx(ws, { runtime }));
    expect((res.data as { entries: string[] }).entries).toEqual(["pkg/", "src/", "src/app.ts"]);
  });
});

describe("search_text sensitive files", () => {
  function withSecrets(): string {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, ".seekforge"));
    fs.writeFileSync(path.join(ws, ".seekforge", "config.json"), '{"apiKey":"sk-secret"}');
    fs.mkdirSync(path.join(ws, ".git"));
    fs.writeFileSync(path.join(ws, ".git", "config"), "url = https://user:sk-token@example.com\n");
    return ws;
  }

  it("never returns SeekForge's config when the search is rooted at .seekforge", async () => {
    const ws = withSecrets();
    for (const target of [".seekforge", ".seekforge/config.json", ".git", ".git/config"]) {
      const data = await run(ws, "search_text", { pattern: "sk-", path: target, includeIgnored: true });
      expect(data.matches, target).toEqual([]);
    }
  });
});

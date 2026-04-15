import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bumpFrecency, loadFrecency, rankFiles, scanWorkspaceFiles } from "../files.js";

let root: string;

function touch(rel: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-files-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("scanWorkspaceFiles", () => {
  it("excludes ignore dirs and dot-directories, uses / separators", () => {
    touch("README.md");
    touch("src/index.ts");
    touch("node_modules/pkg/index.js");
    touch(".hidden/secret.txt");
    const files = scanWorkspaceFiles(root);
    expect(files).toContain("README.md");
    expect(files).toContain("src/index.ts");
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false);
    expect(files.some((f) => f.startsWith(".hidden"))).toBe(false);
  });

  it("lists shallow files before deeper ones (BFS)", () => {
    touch("zzz.txt");
    touch("a/deep.txt");
    touch("a/b/deeper.txt");
    const files = scanWorkspaceFiles(root);
    expect(files.indexOf("zzz.txt")).toBeLessThan(files.indexOf("a/deep.txt"));
    expect(files.indexOf("a/deep.txt")).toBeLessThan(files.indexOf("a/b/deeper.txt"));
  });

  it("respects the limit", () => {
    for (let i = 0; i < 10; i += 1) touch(`f${i}.txt`);
    expect(scanWorkspaceFiles(root, { limit: 4 })).toHaveLength(4);
  });
});

describe("frecency", () => {
  it("loads {} when the file is missing or corrupt", () => {
    expect(loadFrecency(root)).toEqual({});
    fs.mkdirSync(path.join(root, ".seekforge"), { recursive: true });
    fs.writeFileSync(path.join(root, ".seekforge", "tui-frecency.json"), "not json");
    expect(loadFrecency(root)).toEqual({});
  });

  it("bump round-trips count and last", () => {
    bumpFrecency(root, "a.ts");
    bumpFrecency(root, "a.ts");
    bumpFrecency(root, "b.ts");
    const f = loadFrecency(root);
    expect(f["a.ts"]?.count).toBe(2);
    expect(f["b.ts"]?.count).toBe(1);
    expect(typeof f["a.ts"]?.last).toBe("number");
  });

  it("keeps at most 500 entries, dropping the least recent", () => {
    const file = path.join(root, ".seekforge", "tui-frecency.json");
    const big: Record<string, { count: number; last: number }> = {};
    for (let i = 0; i < 500; i += 1) big[`f${i}.ts`] = { count: 1, last: i };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(big));
    bumpFrecency(root, "new.ts");
    const f = loadFrecency(root);
    expect(Object.keys(f)).toHaveLength(500);
    expect(f["new.ts"]).toBeDefined();
    expect(f["f0.ts"]).toBeUndefined(); // oldest dropped
  });
});

describe("rankFiles", () => {
  it("empty query: frecency'd files first (count desc, then last desc), then scan order", () => {
    const files = ["one.ts", "two.ts", "three.ts", "four.ts"];
    const frecency = {
      "three.ts": { count: 2, last: 100 },
      "two.ts": { count: 2, last: 200 },
      "four.ts": { count: 1, last: 300 },
    };
    expect(rankFiles("", files, frecency)).toEqual(["two.ts", "three.ts", "four.ts", "one.ts"]);
  });

  it("non-empty query: fuzzy filter with a frecency boost breaking ties", () => {
    const files = ["src/mode1.ts", "src/mode2.ts", "other.txt"];
    const frecency = { "src/mode2.ts": { count: 5, last: 1 } };
    const ranked = rankFiles("mode", files, frecency);
    expect(ranked).toEqual(["src/mode2.ts", "src/mode1.ts"]);
  });

  it("applies the limit (default 10)", () => {
    const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
    expect(rankFiles("file", files, {})).toHaveLength(10);
    expect(rankFiles("file", files, {}, 3)).toHaveLength(3);
  });
});

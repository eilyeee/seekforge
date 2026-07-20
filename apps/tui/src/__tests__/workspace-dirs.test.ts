import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandExtraFileRefs, formatExtraDirLines, normalizeExtraDir, scanExtraDirs } from "../workspace-dirs.js";

let base: string;
let project: string;
let extra: string;

function touch(root: string, rel: string, content = "x"): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-wd-"));
  project = path.join(base, "project");
  extra = path.join(base, "extra");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(extra, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("normalizeExtraDir", () => {
  it("resolves relative paths against the project path", () => {
    expect(normalizeExtraDir("../extra", project)).toBe(fs.realpathSync(extra));
  });

  it("accepts absolute paths to existing directories", () => {
    expect(normalizeExtraDir(extra, project)).toBe(fs.realpathSync(extra));
  });

  it("pins a symlink alias to the physical directory that was approved", () => {
    const alias = path.join(base, "extra-alias");
    fs.symlinkSync(extra, alias);
    expect(normalizeExtraDir(alias, project)).toBe(fs.realpathSync(extra));
  });

  it("expands ~ against the home directory", () => {
    expect(normalizeExtraDir("~", project)).toBe(os.homedir());
  });

  it("rejects missing paths and plain files", () => {
    expect(normalizeExtraDir(path.join(base, "nope"), project)).toBeNull();
    const file = touch(base, "file.txt");
    expect(normalizeExtraDir(file, project)).toBeNull();
    expect(normalizeExtraDir("", project)).toBeNull();
  });

  it("rejects the project itself and anything inside it", () => {
    fs.mkdirSync(path.join(project, "sub"));
    expect(normalizeExtraDir(project, project)).toBeNull();
    expect(normalizeExtraDir(path.join(project, "sub"), project)).toBeNull();
    expect(normalizeExtraDir("sub", project)).toBeNull(); // relative resolves inside
  });
});

describe("scanExtraDirs", () => {
  it("flattens multiple dirs with provenance and workspace ignore rules", () => {
    const other = path.join(base, "other");
    touch(extra, "a.txt");
    touch(extra, "node_modules/pkg/index.js");
    touch(extra, ".hidden/secret.txt");
    touch(other, "lib/b.ts");
    const results = scanExtraDirs([extra, other]);
    expect(results).toContainEqual({ dir: extra, rel: "a.txt" });
    expect(results).toContainEqual({ dir: other, rel: "lib/b.ts" });
    expect(results.some((r) => r.rel.startsWith("node_modules"))).toBe(false);
    expect(results.some((r) => r.rel.startsWith(".hidden"))).toBe(false);
  });

  it("caps the TOTAL across all dirs", () => {
    const other = path.join(base, "other");
    for (let i = 0; i < 5; i += 1) touch(extra, `e${i}.txt`);
    for (let i = 0; i < 5; i += 1) touch(other, `o${i}.txt`);
    expect(scanExtraDirs([extra, other], 7)).toHaveLength(7);
  });

  it("returns [] for no dirs", () => {
    expect(scanExtraDirs([])).toEqual([]);
  });
});

describe("expandExtraFileRefs", () => {
  it("inlines files referenced by absolute path inside an extra dir", () => {
    const abs = touch(extra, "notes.md", "hello from extra");
    const out = expandExtraFileRefs(`read @${abs} please`, [extra]);
    expect(out).toContain("hello from extra");
    expect(out).toContain(`Referenced file: ${abs}`);
  });

  it("inlines dir-relative tokens", () => {
    touch(extra, "docs/guide.md", "the guide");
    const out = expandExtraFileRefs("see @docs/guide.md", [extra]);
    expect(out).toContain("the guide");
  });

  it("refuses paths outside every extra dir", () => {
    const outside = touch(base, "outside.txt", "secret outside");
    const task = `read @${outside}`;
    expect(expandExtraFileRefs(task, [extra])).toBe(task);
  });

  it("refuses traversal escaping an extra dir", () => {
    touch(base, "escape.txt", "escaped");
    const task = "read @../escape.txt";
    expect(expandExtraFileRefs(task, [extra])).toBe(task);
  });

  it("refuses symlinks escaping an extra dir", () => {
    const outside = touch(base, "outside.txt", "secret outside");
    fs.symlinkSync(outside, path.join(extra, "linked.txt"));
    const task = "read @linked.txt";
    expect(expandExtraFileRefs(task, [extra])).toBe(task);
  });

  it("skips sensitive basenames", () => {
    touch(extra, ".env", "API_KEY=topsecret");
    const task = "read @.env";
    expect(expandExtraFileRefs(task, [extra])).toBe(task);
  });

  it("skips sensitive relative paths", () => {
    touch(extra, ".seekforge/config.json", "provider-secret");
    const task = "read @.seekforge/config.json";
    expect(expandExtraFileRefs(task, [extra])).toBe(task);
  });

  it("skips binary files", () => {
    touch(extra, "blob.bin", "bin\0ary");
    const task = "read @blob.bin";
    expect(expandExtraFileRefs(task, [extra])).toBe(task);
  });

  it("truncates files over the per-file cap", () => {
    touch(extra, "big.txt", "a".repeat(40_000));
    const out = expandExtraFileRefs("read @big.txt", [extra]);
    expect(out).toContain("…[truncated]");
    expect(out.length).toBeLessThan(40_000);
  });

  it("stops at the total cap", () => {
    touch(extra, "one.txt", "1".repeat(29_000));
    touch(extra, "two.txt", "2".repeat(29_000));
    touch(extra, "three.txt", "3".repeat(29_000));
    const out = expandExtraFileRefs("@one.txt @two.txt @three.txt", [extra]);
    const inlined = ["1", "2", "3"].filter((c) => out.includes(c.repeat(100)));
    expect(inlined.length).toBeLessThan(3);
  });

  it("is a no-op with no dirs or no tokens", () => {
    expect(expandExtraFileRefs("plain task", [extra])).toBe("plain task");
    expect(expandExtraFileRefs("@anything", [])).toBe("@anything");
  });
});

describe("formatExtraDirLines", () => {
  it("lists dirs", () => {
    expect(formatExtraDirLines(["/a", "/b"])).toEqual(["↳ /a", "↳ /b"]);
  });

  it("has an empty-state hint", () => {
    expect(formatExtraDirLines([])).toEqual([
      "no extra directories — /add-dir <path> adds one (read-only for @ references)",
    ]);
  });
});

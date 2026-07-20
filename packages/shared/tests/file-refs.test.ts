import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandFileRefs } from "../src/file-refs.js";
import { expandExtraFileRefs } from "../src/workspace-dirs.js";
import { makeTempDir } from "./helpers.js";

describe("bounded referenced-file reads", () => {
  it("caps workspace files before appending them to the task", () => {
    const workspace = makeTempDir();
    writeFileSync(join(workspace, "large.txt"), "x".repeat(500_000));

    const expanded = expandFileRefs("inspect @large.txt", workspace);

    expect(expanded).toContain(`${"x".repeat(30_000)}\n…[truncated]`);
    expect(expanded.length).toBeLessThan(31_000);
  });

  it("caps files from approved extra directories", () => {
    const extra = makeTempDir();
    writeFileSync(join(extra, "large.txt"), "y".repeat(500_000));

    const expanded = expandExtraFileRefs("inspect @large.txt", [extra]);

    expect(expanded).toContain(`${"y".repeat(30_000)}\n…[truncated]`);
    expect(expanded.length).toBeLessThan(31_000);
  });

  it("does not follow a referenced leaf symlink", () => {
    const workspace = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(join(outside, "secret.txt"), "outside-secret");
    mkdirSync(join(workspace, "docs"));
    symlinkSync(join(outside, "secret.txt"), join(workspace, "docs", "secret.txt"));

    expect(expandFileRefs("inspect @docs/secret.txt", workspace)).toBe("inspect @docs/secret.txt");
  });
});

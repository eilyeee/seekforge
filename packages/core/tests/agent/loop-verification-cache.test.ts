import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLoopVerificationCache, recordLoopVerificationCache } from "../../src/agent/loop-verification-cache.js";

describe("Loop verification cache", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("binds successful hints to the exact command and workspace fingerprint", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-cache-"));
    workspaces.push(workspace);
    const fingerprint = "a".repeat(64);
    recordLoopVerificationCache(workspace, "tests", "pnpm test", fingerprint, {
      id: "tests",
      command: "pnpm test",
      code: 0,
      output: "ok",
      attempts: 1,
      flaky: false,
      durationMs: 10,
      selection: "direct",
      matchedPaths: ["packages/core"],
    });
    expect(readLoopVerificationCache(workspace, "tests", "pnpm test", fingerprint)).toMatchObject({
      code: 0,
      output: "ok",
    });
    expect(readLoopVerificationCache(workspace, "tests", "pnpm lint", fingerprint)).toBeUndefined();
    expect(readLoopVerificationCache(workspace, "tests", "pnpm test", "b".repeat(64))).toBeUndefined();
  });

  it("ignores cache records with unknown persisted fields", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-cache-"));
    workspaces.push(workspace);
    const fingerprint = "c".repeat(64);
    recordLoopVerificationCache(workspace, "tests", "pnpm test", fingerprint, {
      id: "tests",
      command: "pnpm test",
      code: 0,
      output: "ok",
      attempts: 1,
      flaky: false,
      durationMs: 10,
    });
    const path = join(workspace, ".seekforge", "loop-verification-cache.json");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.entries[0].result.forged = true;
    mkdirSync(join(workspace, ".seekforge"), { recursive: true });
    writeFileSync(path, JSON.stringify(persisted));
    expect(readLoopVerificationCache(workspace, "tests", "pnpm test", fingerprint)).toBeUndefined();
  });
});

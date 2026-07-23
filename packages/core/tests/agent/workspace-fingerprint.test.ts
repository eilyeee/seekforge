import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceFingerprint } from "../../src/agent/workspace-fingerprint.js";

const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "seekforge-fingerprint-"));
  workspaces.push(path);
  return path;
}

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workspaceFingerprint", () => {
  it("changes when non-git workspace content changes", async () => {
    const root = workspace();
    writeFileSync(join(root, "source.ts"), "one\n");
    const before = await workspaceFingerprint(root);
    writeFileSync(join(root, "source.ts"), "two\n");
    const after = await workspaceFingerprint(root);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("returns null instead of reading a workspace beyond the fingerprint byte budget", async () => {
    const root = workspace();
    const large = join(root, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, 65 * 1024 * 1024);
    await expect(workspaceFingerprint(root)).resolves.toBeNull();
  });

  it("ignores generated skill effectiveness telemetry", async () => {
    const root = workspace();
    writeFileSync(join(root, "source.ts"), "one\n");
    const before = await workspaceFingerprint(root);
    mkdirSync(join(root, ".seekforge"));
    writeFileSync(join(root, ".seekforge", "skills-usage.jsonl"), '{"type":"outcome"}\n');
    const after = await workspaceFingerprint(root);
    expect(after).toBe(before);
  });
});

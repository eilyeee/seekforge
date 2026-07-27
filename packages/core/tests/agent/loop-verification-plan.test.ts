import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLoopVerificationPlan } from "../../src/agent/loop-verification-plan.js";

describe("discoverLoopVerificationPlan", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("selects only recognized package scripts with the detected package manager", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "biome ci .", test: "vitest", deploy: "dangerous custom action" } }),
    );
    expect(discoverLoopVerificationPlan(root)).toEqual({
      stages: [
        { id: "lint", command: "pnpm run lint" },
        { id: "test", command: "pnpm test" },
      ],
      sources: ["package.json"],
    });
  });

  it("combines fixed commands for multi-language roots and rejects unknown roots", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname='demo'\n");
    writeFileSync(join(root, "go.mod"), "module example.test/demo\n");
    expect(discoverLoopVerificationPlan(root).stages.map((stage) => stage.id)).toEqual([
      "cargo-fmt",
      "cargo-test",
      "go-test",
    ]);
    const empty = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(empty);
    expect(() => discoverLoopVerificationPlan(empty)).toThrow(/Could not discover/);
  });

  it("does not let symlinked root markers select executable verification", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    const outside = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-outside-"));
    roots.push(root, outside);
    writeFileSync(join(outside, "Cargo.toml"), "[package]\nname='outside'\n");
    symlinkSync(join(outside, "Cargo.toml"), join(root, "Cargo.toml"));
    expect(() => discoverLoopVerificationPlan(root)).toThrow(/Could not discover/);
  });
});

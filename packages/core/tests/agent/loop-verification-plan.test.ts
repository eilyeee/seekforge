import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("adds bounded path-scoped package tests for a monorepo", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "pnpm -r test" } }));
    writeFileSync(
      join(root, "packages", "core", "package.json"),
      JSON.stringify({ name: "@demo/core", scripts: { test: "vitest", deploy: "never" } }),
    );
    expect(discoverLoopVerificationPlan(root)).toEqual({
      stages: [
        {
          id: "test-packages-core",
          command: "pnpm --filter ./packages/core test",
          paths: ["packages/core"],
          cacheable: true,
        },
        { id: "test", command: "pnpm test" },
      ],
      sources: ["packages/core/package.json", "package.json"],
    });
  });

  it("discovers child package tests when the root package has no recognized scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(join(root, "apps", "web", "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(discoverLoopVerificationPlan(root)).toEqual({
      stages: [
        {
          id: "test-apps-web",
          command: "pnpm --filter ./apps/web test",
          paths: ["apps/web"],
          cacheable: true,
        },
      ],
      sources: ["apps/web/package.json"],
    });
  });

  it("runs dependent package tests when an internal dependency changes", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    mkdirSync(join(root, "packages", "lib"), { recursive: true });
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(
      join(root, "packages", "lib", "package.json"),
      JSON.stringify({ name: "@demo/lib", scripts: { test: "vitest" } }),
    );
    writeFileSync(
      join(root, "apps", "web", "package.json"),
      JSON.stringify({
        name: "@demo/web",
        scripts: { test: "vitest" },
        dependencies: { "@demo/lib": "workspace:*" },
      }),
    );
    const plan = discoverLoopVerificationPlan(root);
    expect(plan.stages.find((stage) => stage.id === "test-apps-web")).toMatchObject({
      paths: ["apps/web", "packages/lib"],
      dependencyPaths: ["packages/lib"],
    });
  });

  it("caps the complete plan while retaining every authoritative root gate", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc", lint: "lint", test: "test", build: "build" } }),
    );
    for (let index = 0; index < 12; index++) {
      const directory = join(root, "packages", `p${String(index).padStart(2, "0")}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    }
    writeFileSync(join(root, "Cargo.toml"), "[workspace]\n");
    writeFileSync(join(root, "go.mod"), "module example.test/demo\n");
    writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    const plan = discoverLoopVerificationPlan(root);
    expect(plan.stages).toHaveLength(16);
    expect(plan.stages.map((stage) => stage.id)).toEqual(
      expect.arrayContaining(["typecheck", "lint", "test", "build", "cargo-fmt", "cargo-test", "go-test", "pytest"]),
    );
  });

  it("does not let symlinked root markers select executable verification", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    const outside = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-outside-"));
    roots.push(root, outside);
    writeFileSync(join(outside, "Cargo.toml"), "[package]\nname='outside'\n");
    symlinkSync(join(outside, "Cargo.toml"), join(root, "Cargo.toml"));
    expect(() => discoverLoopVerificationPlan(root)).toThrow(/Could not discover/);
  });

  it("discovers custom pnpm workspace parents and nested language modules", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    mkdirSync(join(root, "tools", "lint"), { recursive: true });
    mkdirSync(join(root, "services", "api"), { recursive: true });
    mkdirSync(join(root, "modules", "python"), { recursive: true });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'tools/*'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(join(root, "tools", "lint", "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    writeFileSync(join(root, "services", "api", "go.mod"), "module example.test/api\n");
    writeFileSync(join(root, "modules", "python", "pyproject.toml"), "[tool.pytest.ini_options]\n");
    const plan = discoverLoopVerificationPlan(root);
    expect(plan.stages.map((stage) => stage.id)).toEqual(
      expect.arrayContaining(["test-tools-lint", "go-services-api", "pytest-modules-python"]),
    );
  });

  it("bounds generated stage ids for long but safe workspace names", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    const name = `package-${"x".repeat(100)}`;
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const [stage] = discoverLoopVerificationPlan(root).stages;
    expect(stage?.id.length).toBeLessThanOrEqual(128);
    expect(stage?.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  });

  it("normalizes dots out of generated stage ids", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-plan-"));
    roots.push(root);
    mkdirSync(join(root, "packages", "web.app"), { recursive: true });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(join(root, "packages", "web.app", "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(discoverLoopVerificationPlan(root).stages[0]?.id).toBe("test-packages-web-app");
  });
});

/** Guards the evals/ dataset itself: tasks parse, fixtures exist and are hermetic. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDir, tasksDir } from "../src/paths.js";
import { assertFixturesExist, loadTasks, validateCheck, validateTask } from "../src/tasks.js";

describe("evals/ dataset", () => {
  const tasks = loadTasks(tasksDir);

  it("contains the sixty-eight expected tasks", () => {
    expect(tasks.map((t) => t.id)).toEqual([
      "add-function",
      "add-missing-tests",
      "ambiguous-dedup",
      "api-version-migration",
      "ask-codebase",
      "async-race-fix",
      "buried-feature-flag",
      "cjk-buried-discount",
      "cjk-buried-retry",
      "cjk-find-checkout",
      "cjk-large-paginate",
      "cjk-review-edge",
      "config-doc-allowlist",
      "cross-module-bug",
      "deprecated-api-migration",
      "error-handling",
      "error-path-typed",
      "error-swallow-fix",
      "extend-without-regress",
      "failing-test-fix",
      "feature-edge-cases",
      "fix-without-regression",
      "foreach-await-bug",
      "go-pagination-window",
      "graph-failure-continue",
      "graph-gate-approval",
      "graph-multi-node",
      "graph-rerun-descendants",
      "graph-wait-signal",
      "guarded-no-delete",
      "hard-buried-bug-scale",
      "hard-csv-parser",
      "hard-expr-eval",
      "hard-feature-multistep",
      "hard-multi-bug",
      "hard-rename-signature",
      "hard-thread-actor",
      "json-config-edit",
      "large-context-nav",
      "loop-interrupt-resume",
      "loop-resume-two-stage",
      "loop-verify-green",
      "memory-convention-recall",
      "memory-error-convention",
      "memory-rejection-lifecycle",
      "multi-file-extract-helper",
      "multi-root-shared-util",
      "no-progress-flaky-guard",
      "null-guard-fix",
      "off-by-one-fix",
      "pagination-window-fix",
      "perf-nested-loop",
      "pipeline-transform-bug",
      "python-path-normalization",
      "regression-guard",
      "rename-across-files",
      "rename-helper-fn",
      "rounding-half-even",
      "run-ledger-byte-cursor",
      "rust-utf8-truncate",
      "schema-migration",
      "settle-currency-bug",
      "spec-to-feature",
      "staged-rollout-refactor",
      "surrogate-pair-slice",
      "title-change",
      "ts-generic-inference",
      "ts-typing-fix",
    ]);
  });

  it("keeps observed real-project failures identifiable", () => {
    const observed = tasks.filter(
      (task) => task.provenance?.kind === "dogfood" || task.provenance?.kind === "external",
    );
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((task) => Boolean(task.provenance?.source))).toBe(true);
  });

  it("every task's fixture exists", () => {
    expect(() => assertFixturesExist(tasks, fixturesDir)).not.toThrow();
  });

  it("every fixture declares no package dependencies", () => {
    for (const task of tasks) {
      const pkgPath = join(fixturesDir, task.fixture, "package.json");
      expect(existsSync(pkgPath), `${task.fixture}/package.json`).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      expect(pkg.dependencies, `${task.fixture} must not declare dependencies`).toBeUndefined();
      expect(pkg.devDependencies, `${task.fixture} must not declare devDependencies`).toBeUndefined();
    }
  });

  it("every check pattern compiles as a regex (validated on load)", () => {
    for (const task of tasks) {
      for (const check of task.checks) {
        if ("pattern" in check) expect(() => new RegExp(check.pattern)).not.toThrow();
      }
    }
  });
});

describe("task validation", () => {
  const valid = {
    id: "t",
    title: "T",
    fixture: "fx",
    mode: "edit",
    task: "do it",
    checks: [{ type: "command_succeeds", command: "true" }],
  };

  it("accepts a valid task and every check shape", () => {
    expect(() => validateTask(valid, "t")).not.toThrow();
    expect(() => validateCheck({ type: "file_contains", path: "a", pattern: "x" }, "c")).not.toThrow();
    expect(() => validateCheck({ type: "file_not_contains", path: "a", pattern: "x" }, "c")).not.toThrow();
    expect(() => validateCheck({ type: "command_succeeds", command: "true", cwd: "sub" }, "c")).not.toThrow();
    expect(() => validateCheck({ type: "answer_matches", pattern: "x" }, "c")).not.toThrow();
    expect(() => validateCheck({ type: "memory_stats", field: "approved", equals: 1 }, "c")).not.toThrow();
    expect(() =>
      validateCheck(
        {
          type: "memory_fact_activity",
          fact: "[convention] x",
          activity: "exposures",
          equals: 0,
        },
        "c",
      ),
    ).not.toThrow();
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "loop",
          loop: { verifyCommand: "npm test", maxIterations: 2, expectedStatus: "passed" },
        },
        "loop",
      ),
    ).not.toThrow();
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "loop",
          loop: {
            verifyCommand: "npm test",
            maxIterations: 2,
            expectedStatus: "passed",
            tokenBudget: 2_000,
            maxDurationMs: 60_000,
            stablePasses: 2,
            flakyRetries: 1,
            maxNoProgressRecoveries: 2,
            verificationPlan: [
              { id: "types", command: "npm run typecheck" },
              { id: "test", command: "npm test" },
            ],
            resume: { expectedInitialStatus: "budget", additionalTokenBudget: 500 },
          },
        },
        "loop-v2",
      ),
    ).not.toThrow();
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "session_scenario",
          scenario: { steps: [{ type: "agent" }, { type: "agent", resume: true }] },
        },
        "scenario",
      ),
    ).not.toThrow();
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "graph",
          graph: {
            expectedStatus: "passed",
            definition: {
              graphId: "sample",
              nodes: [
                { id: "implement", kind: "agent", task: "do it" },
                { id: "review", kind: "gate", dependsOn: ["implement"] },
                { id: "publish", kind: "function", handler: "collect", dependsOn: ["review"] },
              ],
            },
            resume: { expectedInitialStatus: "paused", approve: ["review"], signals: [{ name: "go" }] },
          },
        },
        "graph",
      ),
    ).not.toThrow();
  });

  it("rejects bad shapes", () => {
    expect(() => validateTask({ ...valid, id: "" }, "t")).toThrow(/"id"/);
    for (const id of ["../escape", "bad/id", "bad\\id", "bad|id", `a${"x".repeat(128)}`]) {
      expect(() => validateTask({ ...valid, id }, "t"), id).toThrow(/portable identifier/);
    }
    expect(() => validateTask({ ...valid, mode: "chat" }, "t")).toThrow(/"mode"/);
    expect(() => validateTask({ ...valid, checks: [] }, "t")).toThrow(/"checks"/);
    expect(() => validateTask({ ...valid, provenance: { kind: "dogfood" } }, "t")).toThrow(/source/);
    expect(() => validateTask({ ...valid, provenance: { kind: "invented" } }, "t")).toThrow(/provenance.kind/);
    expect(() => validateCheck({ type: "llm_judge", pattern: "x" }, "c")).toThrow(/unknown check type/);
    expect(() => validateCheck({ type: "file_contains", path: "a" }, "c")).toThrow(/"pattern"/);
    expect(() => validateCheck({ type: "file_contains", path: "a", pattern: "(" }, "c")).toThrow(/regex/);
    expect(() => validateCheck({ type: "command_succeeds" }, "c")).toThrow(/"command"/);
    for (const path of [
      "../outside",
      "..\\outside",
      "safe/../../outside",
      "safe\\..\\..\\outside",
      "/absolute/path",
      "\\absolute\\path",
      "C:/absolute/path",
      "C:\\absolute\\path",
      "C:drive-relative",
      "//server/share/file",
      "\\\\server\\share\\file",
      "\\\\?\\C:\\device-path",
    ]) {
      expect(() => validateCheck({ type: "file_contains", path, pattern: "x" }, "c"), path).toThrow(/within/);
    }
    expect(() =>
      validateCheck(
        {
          type: "file_contains",
          path: "safe\\nested/file.txt",
          pattern: "x",
        },
        "c",
      ),
    ).not.toThrow();
    expect(() => validateCheck({ type: "memory_stats", field: "missing", equals: 0 }, "c")).toThrow(/memoryStats/);
    expect(() =>
      validateCheck(
        {
          type: "memory_fact_activity",
          fact: "x",
          activity: "bad",
          equals: 0,
        },
        "c",
      ),
    ).toThrow(/activity/);
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "loop",
          loop: {
            verifyCommand: "npm test",
            maxIterations: 0,
            expectedStatus: "passed",
          },
        },
        "t",
      ),
    ).toThrow(/maxIterations/);
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "loop",
          loop: {
            verifyCommand: "npm test",
            maxIterations: 2,
            expectedStatus: "passed",
            verificationPlan: [
              { id: "test", command: "npm test" },
              { id: "test", command: "npm test again" },
            ],
          },
        },
        "loop-v2",
      ),
    ).toThrow(/verificationPlan/);
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "session_scenario",
          scenario: {
            steps: [{ type: "agent", resume: true }],
          },
        },
        "t",
      ),
    ).toThrow(/earlier agent/);
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "session_scenario",
          scenario: {
            steps: [{ type: "memory.approve", key: "missing" }, { type: "agent" }],
          },
        },
        "t",
      ),
    ).toThrow(/unknown memory alias/);
  });

  it("delegates verification-plan rules to the shared contract", () => {
    const loopTask = (verificationPlan: unknown) => () =>
      validateTask(
        {
          ...valid,
          runner: "loop",
          loop: { verifyCommand: "npm test", maxIterations: 2, expectedStatus: "passed", verificationPlan },
        },
        "loop-v2",
      );
    // A task file is authored text, so a misspelled field is a fixture bug.
    expect(loopTask([{ id: "a", command: "npm test", futureField: 1 }])).toThrow(/unsupported field: futureField/);
    // Rules the hand-rolled copy never had: a cycle, a bad resource name, a
    // parallel stage with nothing to reserve, and a timeout no timer can hold.
    expect(
      loopTask([
        { id: "a", command: "npm test", dependsOn: ["b"] },
        { id: "b", command: "npm test", dependsOn: ["a"] },
      ]),
    ).toThrow(/stage dependency cycle/);
    expect(loopTask([{ id: "a", command: "npm test", resources: ["not a name"] }])).toThrow(/unique safe names/);
    expect(loopTask([{ id: "a", command: "npm test", parallel: true }])).toThrow(/parallel requires resources/);
    expect(loopTask([{ id: "a", command: "npm test", timeoutMs: 2_147_483_648 }])).toThrow(/timeoutMs/);
    // …and the four fields the copy silently dropped now survive the parse.
    const task = validateTask(
      {
        ...valid,
        runner: "loop",
        loop: {
          verifyCommand: "npm test",
          maxIterations: 2,
          expectedStatus: "passed",
          verificationPlan: [
            { id: "unit", command: "npm test", paths: ["src"], dependencyPaths: ["src"], cacheable: true },
            { id: "e2e", command: "npm run e2e", dependsOn: ["unit"], parallel: true, resources: ["browser"] },
          ],
        },
      },
      "loop-v2",
    );
    expect(task.loop?.verificationPlan).toEqual([
      { id: "unit", command: "npm test", paths: ["src"], dependencyPaths: ["src"], cacheable: true },
      { id: "e2e", command: "npm run e2e", dependsOn: ["unit"], parallel: true, resources: ["browser"] },
    ]);
  });

  it("delegates graph rules to core instead of re-implementing them", () => {
    const graphTask = (graph: unknown) => () => validateTask({ ...valid, runner: "graph", graph }, "g");
    const nodes = [{ id: "only", kind: "function", handler: "collect" }];
    expect(graphTask({ expectedStatus: "passed", definition: { graphId: "g", nodes: [] } })).toThrow();
    expect(graphTask({ expectedStatus: "shipped", definition: { graphId: "g", nodes } })).toThrow(/Graph run status/);
    // Core owns these: an unregistered handler, an unknown gate, and a rerun
    // selection that names a node the definition never declared.
    expect(
      graphTask({
        expectedStatus: "passed",
        definition: { graphId: "g", nodes: [{ id: "only", kind: "function", handler: "shell" }] },
      }),
    ).toThrow(/handler is not registered/);
    expect(graphTask({ expectedStatus: "passed", definition: { graphId: "g", nodes }, approve: ["only"] })).toThrow(
      /approvedNodeIds/,
    );
    expect(
      graphTask({
        expectedStatus: "passed",
        definition: { graphId: "g", nodes },
        resume: { expectedInitialStatus: "paused", rerun: ["ghost"] },
      }),
    ).toThrow(/rerunFrom/);
    expect(
      graphTask({
        expectedStatus: "passed",
        definition: { graphId: "g", nodes },
        resume: { expectedInitialStatus: "paused" },
      }),
    ).toThrow(/approve, rerun, or deliver a signal/);
    expect(
      graphTask({
        expectedStatus: "passed",
        definition: { graphId: "g", nodes },
        resume: { expectedInitialStatus: "paused", signals: [{ name: "bad name" }] },
      }),
    ).toThrow(/safe signal id/);
    expect(() =>
      validateTask({ ...valid, runner: "graph", mode: "ask", graph: { expectedStatus: "passed" } }, "g"),
    ).toThrow(/edit mode/);
    expect(() =>
      validateTask(
        {
          ...valid,
          runner: "loop",
          loop: { verifyCommand: "npm test", maxIterations: 1, expectedStatus: "passed" },
          graph: { expectedStatus: "passed", definition: { graphId: "g", nodes } },
        },
        "g",
      ),
    ).toThrow(/cannot define scenario or graph config/);
  });
});

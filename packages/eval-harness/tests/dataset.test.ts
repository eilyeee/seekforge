/** Guards the evals/ dataset itself: tasks parse, fixtures exist and are hermetic. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDir, tasksDir } from "../src/paths.js";
import { assertFixturesExist, loadTasks, validateCheck, validateTask } from "../src/tasks.js";

describe("evals/ dataset", () => {
  const tasks = loadTasks(tasksDir);

  it("contains the fifty-five expected tasks", () => {
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
      "loop-verify-green",
      "memory-convention-recall",
      "memory-error-convention",
      "multi-file-extract-helper",
      "multi-root-shared-util",
      "no-progress-flaky-guard",
      "null-guard-fix",
      "off-by-one-fix",
      "pagination-window-fix",
      "perf-nested-loop",
      "pipeline-transform-bug",
      "regression-guard",
      "rename-across-files",
      "rename-helper-fn",
      "rounding-half-even",
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

  it("every task's fixture exists", () => {
    expect(() => assertFixturesExist(tasks, fixturesDir)).not.toThrow();
  });

  it("every fixture uses only node built-ins (no dependencies to install)", () => {
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
  });

  it("rejects bad shapes", () => {
    expect(() => validateTask({ ...valid, id: "" }, "t")).toThrow(/"id"/);
    expect(() => validateTask({ ...valid, mode: "chat" }, "t")).toThrow(/"mode"/);
    expect(() => validateTask({ ...valid, checks: [] }, "t")).toThrow(/"checks"/);
    expect(() => validateCheck({ type: "llm_judge", pattern: "x" }, "c")).toThrow(/unknown check type/);
    expect(() => validateCheck({ type: "file_contains", path: "a" }, "c")).toThrow(/"pattern"/);
    expect(() => validateCheck({ type: "file_contains", path: "a", pattern: "(" }, "c")).toThrow(/regex/);
    expect(() => validateCheck({ type: "command_succeeds" }, "c")).toThrow(/"command"/);
  });
});

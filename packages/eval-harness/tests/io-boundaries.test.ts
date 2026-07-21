import { lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBaseline } from "../src/baseline.js";
import { writeJunit } from "../src/junit.js";
import {
  MAX_BASELINE_BYTES,
  MAX_DATASET_FILE_BYTES,
  MAX_SUITE_CONFIG_BYTES,
  MAX_TASK_FILE_BYTES,
  MAX_TREND_REPORT_BYTES,
} from "../src/limits.js";
import { hashDataset } from "../src/run-metadata.js";
import { loadSuiteConfig } from "../src/suite-config.js";
import { loadTasks, type TaskDef } from "../src/tasks.js";
import { collectTrends } from "../src/trends.js";

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), "seekforge-eval-io-"));
}

describe("eval file boundaries", () => {
  it("rejects oversized suite, task, and baseline inputs before parsing", () => {
    const root = makeFixture();
    const suite = join(root, "suite.json");
    const tasks = join(root, "tasks");
    mkdirSync(tasks);
    writeFileSync(suite, Buffer.alloc(MAX_SUITE_CONFIG_BYTES + 1, 0x20));
    writeFileSync(join(tasks, "large.json"), Buffer.alloc(MAX_TASK_FILE_BYTES + 1, 0x20));

    expect(() => loadSuiteConfig(suite)).toThrow(/exceeds/);
    expect(() => loadTasks(tasks)).toThrow(/exceeds/);
    expect(() => parseBaseline(" ".repeat(MAX_BASELINE_BYTES + 1))).toThrow(/baseline exceeds/);
  });

  it("skips an oversized historical trend report", () => {
    const dir = makeFixture();
    writeFileSync(join(dir, "oversized.json"), Buffer.alloc(MAX_TREND_REPORT_BYTES + 1, 0x20));
    expect(collectTrends(dir)).toEqual([]);
  });

  it("rejects oversized fixture files while hashing run metadata", () => {
    const fixtureRoot = makeFixture();
    const fixture = join(fixtureRoot, "fx");
    mkdirSync(fixture);
    const large = join(fixture, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, MAX_DATASET_FILE_BYTES + 1);
    const task: TaskDef = {
      id: "metadata-boundary",
      title: "Metadata boundary",
      fixture: "fx",
      mode: "edit",
      task: "test",
      checks: [{ type: "command_succeeds", command: "true" }],
      runner: "agent",
      expectedStatus: "completed",
    };
    expect(() => hashDataset([task], fixtureRoot)).toThrow(/dataset file exceeds/);
  });

  it("atomically replaces a JUnit symlink instead of overwriting its target", () => {
    const dir = makeFixture();
    const outside = join(dir, "outside.xml");
    const target = join(dir, "junit.xml");
    writeFileSync(outside, "keep");
    symlinkSync(outside, target);

    writeJunit([], target);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(readFileSync(target, "utf8")).toContain("<testsuite");
  });
});

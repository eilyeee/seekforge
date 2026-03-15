/**
 * Eval task dataset: types, hand-rolled validation (no extra deps), loading.
 *
 * Scoring is deterministic-first: checks are file/command/answer assertions,
 * never LLM judges.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Check =
  | { type: "file_contains"; path: string; pattern: string }
  | { type: "file_not_contains"; path: string; pattern: string }
  | { type: "command_succeeds"; command: string; cwd?: string }
  | { type: "answer_matches"; pattern: string };

export type TaskDef = {
  id: string;
  title: string;
  fixture: string;
  mode: "ask" | "edit";
  task: string;
  checks: Check[];
  notes?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
}

function requirePattern(obj: Record<string, unknown>, key: string, where: string): string {
  const pattern = requireString(obj, key, where);
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(`${where}: "${key}" is not a valid regex: ${(err as Error).message}`);
  }
  return pattern;
}

export function validateCheck(value: unknown, where: string): Check {
  if (!isRecord(value)) throw new Error(`${where}: check must be an object`);
  switch (value.type) {
    case "file_contains":
    case "file_not_contains":
      return {
        type: value.type,
        path: requireString(value, "path", where),
        pattern: requirePattern(value, "pattern", where),
      };
    case "command_succeeds": {
      const check: Check = { type: "command_succeeds", command: requireString(value, "command", where) };
      if (value.cwd !== undefined) check.cwd = requireString(value, "cwd", where);
      return check;
    }
    case "answer_matches":
      return { type: "answer_matches", pattern: requirePattern(value, "pattern", where) };
    default:
      throw new Error(`${where}: unknown check type ${JSON.stringify(value.type)}`);
  }
}

export function validateTask(value: unknown, where: string): TaskDef {
  if (!isRecord(value)) throw new Error(`${where}: task must be an object`);
  const mode = value.mode;
  if (mode !== "ask" && mode !== "edit") {
    throw new Error(`${where}: "mode" must be "ask" or "edit"`);
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    throw new Error(`${where}: "checks" must be a non-empty array`);
  }
  const task: TaskDef = {
    id: requireString(value, "id", where),
    title: requireString(value, "title", where),
    fixture: requireString(value, "fixture", where),
    mode,
    task: requireString(value, "task", where),
    checks: value.checks.map((c, i) => validateCheck(c, `${where} checks[${i}]`)),
  };
  if (value.notes !== undefined) task.notes = requireString(value, "notes", where);
  return task;
}

/** Loads and validates all tasks in a directory, sorted by id. */
export function loadTasks(dir: string): TaskDef[] {
  const tasks: TaskDef[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    tasks.push(validateTask(parsed, entry));
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/** Asserts that every task's fixture directory exists under fixturesRoot. */
export function assertFixturesExist(tasks: TaskDef[], fixturesRoot: string): void {
  for (const task of tasks) {
    const dir = join(fixturesRoot, task.fixture);
    if (!existsSync(dir)) {
      throw new Error(`task ${task.id}: fixture directory not found: ${dir}`);
    }
  }
}

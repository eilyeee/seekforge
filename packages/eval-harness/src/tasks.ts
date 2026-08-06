/**
 * Eval task dataset: types, hand-rolled validation (no extra deps), loading.
 *
 * Scoring is deterministic-first: checks are file/command/answer assertions,
 * never LLM judges. Legacy tasks without `runner` remain single agent runs.
 */

import { existsSync, opendirSync } from "node:fs";
import { join, posix } from "node:path";
import {
  MAX_LOOP_ITERATIONS,
  MEMORY_CANDIDATE_TYPES,
  type LoopEvent,
  type LoopStatus,
  type LoopVerificationStage,
  type LoopRequirementMode,
  type MemoryCandidateType,
  type MemoryStats,
} from "@seekforge/core";
import { readTextFileBounded } from "./file-io.js";
import { MAX_TASK_FILE_BYTES, MAX_TASK_FILES } from "./limits.js";
import { compareByCodePoints } from "@seekforge/shared";

export const TASK_RUNNERS = ["agent", "loop", "session_scenario"] as const;
export type TaskRunner = (typeof TASK_RUNNERS)[number];
export type ExpectedSessionStatus = "completed" | "failed";
export type MemoryStatField = keyof MemoryStats;

export type Check =
  | { type: "file_contains"; path: string; pattern: string }
  | { type: "file_not_contains"; path: string; pattern: string }
  | { type: "command_succeeds"; command: string; cwd?: string }
  | { type: "answer_matches"; pattern: string }
  | { type: "memory_stats"; field: MemoryStatField; equals: number | null; tolerance?: number }
  | {
      type: "memory_fact_activity";
      fact: string;
      activity: "uses" | "exposures" | "retrievals";
      equals: number;
    };

export type LoopResumeConfig = {
  expectedInitialStatus: LoopStatus;
  additionalIterations?: number;
  additionalCostBudgetUsd?: number;
  additionalTokenBudget?: number;
  additionalDurationMs?: number;
  additionalVerifyRuns?: number;
};

export type LoopTaskConfig = {
  verifyCommand: string;
  maxIterations: number;
  expectedStatus: LoopStatus;
  costBudgetUsd?: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  maxVerifyRuns?: number;
  verifyTimeoutMs?: number;
  agentTimeoutMs?: number;
  maxAgentRetries?: number;
  verificationPlan?: LoopVerificationStage[];
  stablePasses?: number;
  flakyRetries?: number;
  maxNoProgressRecoveries?: number;
  rollbackOnRegression?: boolean;
  adaptiveBudget?: boolean;
  requirementMode?: LoopRequirementMode;
  /** Deterministic lifecycle interruption used by resilience fixtures. */
  interruptAfterEvent?: LoopEvent["type"];
  /** One-based matching occurrence; defaults to the first boundary. */
  interruptAfterOccurrence?: number;
  resume?: LoopResumeConfig;
};

export type SessionScenarioStep =
  | {
      type: "agent";
      task?: string;
      mode?: "ask" | "edit";
      resume?: boolean;
      expectedStatus?: ExpectedSessionStatus;
    }
  | {
      type: "memory.add";
      key: string;
      content: string;
      memoryType?: MemoryCandidateType;
      approve?: boolean;
    }
  | { type: "memory.approve"; key: string }
  | { type: "memory.reject"; key: string };

export type SessionScenarioConfig = { steps: SessionScenarioStep[] };

export type TaskProvenance = {
  /** How the task entered the dataset; dogfood/external tasks must name their source. */
  kind: "synthetic" | "dogfood" | "external";
  source?: string;
};

export type TaskDef = {
  id: string;
  title: string;
  fixture: string;
  mode: "ask" | "edit";
  task: string;
  checks: Check[];
  notes?: string;
  provenance?: TaskProvenance;
  /** Omitted is the historical single-run behavior. */
  runner?: TaskRunner;
  expectedStatus?: ExpectedSessionStatus;
  loop?: LoopTaskConfig;
  scenario?: SessionScenarioConfig;
};

const LOOP_STATUSES = new Set<LoopStatus>([
  "passed",
  "exhausted",
  "no_progress",
  "budget",
  "cancelled",
  "verify_error",
  "agent_error",
  "interrupted",
  "requirements_pending",
]);
const INTERRUPTIBLE_LOOP_EVENTS = new Set<LoopEvent["type"]>([
  "iteration.start",
  "run.completed",
  "verify",
  "loop.snapshot",
  "requirements.completed",
]);
const MEMORY_STAT_FIELDS = new Set<MemoryStatField>([
  "totalApprovedFacts",
  "autoExtractedFacts",
  "directAddedFacts",
  "usedFraction",
  "exposedFraction",
  "retrievalCount",
  "rejectionRate",
  "avgConfidenceUsed",
  "avgConfidenceUnused",
  "pending",
  "approved",
  "rejected",
]);
const NULLABLE_MEMORY_STATS = new Set<MemoryStatField>(["avgConfidenceUsed", "avgConfidenceUnused"]);
const FRACTION_MEMORY_STATS = new Set<MemoryStatField>([
  "usedFraction",
  "exposedFraction",
  "rejectionRate",
  "avgConfidenceUsed",
  "avgConfidenceUnused",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  return value;
}

function requireTaskId(obj: Record<string, unknown>, where: string): string {
  const id = requireString(obj, "id", where);
  if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`${where}: "id" must be 1-128 portable identifier characters (letters, digits, ., _, -)`);
  }
  return id;
}

function requireRelativePath(obj: Record<string, unknown>, key: string, where: string): string {
  const value = requireString(obj, key, where);
  // Task data is portable: reject Windows and POSIX escape forms regardless of
  // the platform loading this file. A drive-relative `C:foo` is unsafe too.
  const portable = value.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (
    value.includes("\0") ||
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`${where}: "${key}" must stay within the fixture workspace`);
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

function positiveInteger(value: unknown, where: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${where} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${where} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where} must be a finite positive number`);
  }
  return value;
}

function expectedSessionStatus(value: unknown, where: string): ExpectedSessionStatus {
  if (value !== "completed" && value !== "failed") {
    throw new Error(`${where} must be "completed" or "failed"`);
  }
  return value;
}

function loopStatus(value: unknown, where: string): LoopStatus {
  if (typeof value !== "string" || !LOOP_STATUSES.has(value as LoopStatus)) {
    throw new Error(`${where} must be a valid Loop terminal status`);
  }
  return value as LoopStatus;
}

export function validateCheck(value: unknown, where: string): Check {
  if (!isRecord(value)) throw new Error(`${where}: check must be an object`);
  switch (value.type) {
    case "file_contains":
    case "file_not_contains":
      return {
        type: value.type,
        path: requireRelativePath(value, "path", where),
        pattern: requirePattern(value, "pattern", where),
      };
    case "command_succeeds": {
      const check: Check = { type: "command_succeeds", command: requireString(value, "command", where) };
      if (value.cwd !== undefined) check.cwd = requireRelativePath(value, "cwd", where);
      return check;
    }
    case "answer_matches":
      return { type: "answer_matches", pattern: requirePattern(value, "pattern", where) };
    case "memory_stats": {
      if (typeof value.field !== "string" || !MEMORY_STAT_FIELDS.has(value.field as MemoryStatField)) {
        throw new Error(`${where}: "field" must be a memoryStats field`);
      }
      const field = value.field as MemoryStatField;
      const expected = value.equals;
      if (expected === null) {
        if (!NULLABLE_MEMORY_STATS.has(field)) throw new Error(`${where}: "equals" cannot be null for ${field}`);
      } else if (
        typeof expected !== "number" ||
        !Number.isFinite(expected) ||
        expected < 0 ||
        (FRACTION_MEMORY_STATS.has(field) && expected > 1) ||
        (!FRACTION_MEMORY_STATS.has(field) && !Number.isSafeInteger(expected))
      ) {
        throw new Error(`${where}: "equals" is invalid for memory stat ${field}`);
      }
      const check: Check = { type: "memory_stats", field, equals: expected as number | null };
      if (value.tolerance !== undefined) {
        if (typeof value.tolerance !== "number" || !Number.isFinite(value.tolerance) || value.tolerance < 0) {
          throw new Error(`${where}: "tolerance" must be a finite non-negative number`);
        }
        check.tolerance = value.tolerance;
      }
      return check;
    }
    case "memory_fact_activity":
      if (value.activity !== "uses" && value.activity !== "exposures" && value.activity !== "retrievals") {
        throw new Error(`${where}: "activity" must be uses, exposures, or retrievals`);
      }
      return {
        type: "memory_fact_activity",
        fact: requireString(value, "fact", where).replace(/^-\s*/, "").trim(),
        activity: value.activity,
        equals: nonNegativeInteger(value.equals, `${where}: "equals"`),
      };
    default:
      throw new Error(`${where}: unknown check type ${JSON.stringify(value.type)}`);
  }
}

function parseLoop(value: unknown, where: string): LoopTaskConfig {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const maxIterations = positiveInteger(value.maxIterations, `${where}.maxIterations`, MAX_LOOP_ITERATIONS);
  const loop: LoopTaskConfig = {
    verifyCommand: requireString(value, "verifyCommand", where),
    maxIterations,
    expectedStatus: loopStatus(value.expectedStatus, `${where}.expectedStatus`),
  };
  if (value.costBudgetUsd !== undefined)
    loop.costBudgetUsd = positiveNumber(value.costBudgetUsd, `${where}.costBudgetUsd`);
  for (const [name, maximum] of [
    ["tokenBudget", Number.MAX_SAFE_INTEGER],
    ["maxDurationMs", Number.MAX_SAFE_INTEGER],
    ["maxVerifyRuns", Number.MAX_SAFE_INTEGER],
    ["verifyTimeoutMs", Number.MAX_SAFE_INTEGER],
    ["agentTimeoutMs", Number.MAX_SAFE_INTEGER],
    ["maxAgentRetries", 5],
    ["stablePasses", 5],
    ["flakyRetries", 5],
    ["maxNoProgressRecoveries", 5],
  ] as const) {
    const candidate = value[name];
    if (candidate === undefined) continue;
    const allowZero = name === "maxAgentRetries" || name === "flakyRetries" || name === "maxNoProgressRecoveries";
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < (allowZero ? 0 : 1) ||
      (candidate as number) > maximum
    ) {
      throw new Error(`${where}.${name} must be ${allowZero ? "a non-negative" : "a positive"} bounded integer`);
    }
    (loop as Record<string, unknown>)[name] = candidate;
  }
  if (value.rollbackOnRegression !== undefined) {
    if (typeof value.rollbackOnRegression !== "boolean")
      throw new Error(`${where}.rollbackOnRegression must be boolean`);
    loop.rollbackOnRegression = value.rollbackOnRegression;
  }
  if (value.adaptiveBudget !== undefined) {
    if (typeof value.adaptiveBudget !== "boolean") throw new Error(`${where}.adaptiveBudget must be boolean`);
    loop.adaptiveBudget = value.adaptiveBudget;
  }
  if (value.requirementMode !== undefined) {
    if (
      value.requirementMode !== "quick" &&
      value.requirementMode !== "analyze" &&
      value.requirementMode !== "confirm"
    ) {
      throw new Error(`${where}.requirementMode must be quick, analyze, or confirm`);
    }
    loop.requirementMode = value.requirementMode;
  }
  if (value.interruptAfterEvent !== undefined) {
    if (
      typeof value.interruptAfterEvent !== "string" ||
      !INTERRUPTIBLE_LOOP_EVENTS.has(value.interruptAfterEvent as LoopEvent["type"])
    ) {
      throw new Error(`${where}.interruptAfterEvent must be a supported lifecycle boundary`);
    }
    loop.interruptAfterEvent = value.interruptAfterEvent as LoopEvent["type"];
    if (value.interruptAfterOccurrence !== undefined) {
      loop.interruptAfterOccurrence = positiveInteger(
        value.interruptAfterOccurrence,
        `${where}.interruptAfterOccurrence`,
        1_000,
      );
    }
  } else if (value.interruptAfterOccurrence !== undefined) {
    throw new Error(`${where}.interruptAfterOccurrence requires interruptAfterEvent`);
  }
  if (value.verificationPlan !== undefined) {
    if (
      !Array.isArray(value.verificationPlan) ||
      value.verificationPlan.length === 0 ||
      value.verificationPlan.length > 16
    ) {
      throw new Error(`${where}.verificationPlan must contain 1 to 16 stages`);
    }
    const ids = new Set<string>();
    loop.verificationPlan = value.verificationPlan.map((raw, index) => {
      const stageWhere = `${where}.verificationPlan[${index}]`;
      if (
        !isRecord(raw) ||
        typeof raw.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.id) ||
        ids.has(raw.id) ||
        typeof raw.command !== "string" ||
        raw.command.trim() === "" ||
        raw.command.length > 8_192 ||
        (raw.required !== undefined && typeof raw.required !== "boolean") ||
        (raw.cacheable !== undefined && typeof raw.cacheable !== "boolean") ||
        (raw.dependencyPaths !== undefined &&
          (!Array.isArray(raw.dependencyPaths) ||
            raw.dependencyPaths.length === 0 ||
            raw.dependencyPaths.length > 64 ||
            raw.dependencyPaths.some((path) => !Array.isArray(raw.paths) || !raw.paths.includes(path)))) ||
        (raw.paths !== undefined &&
          (!Array.isArray(raw.paths) ||
            raw.paths.length === 0 ||
            raw.paths.length > 64 ||
            raw.paths.some(
              (path) =>
                typeof path !== "string" ||
                path.length === 0 ||
                path.length > 512 ||
                path.startsWith("/") ||
                /^[A-Za-z]:[\\/]/.test(path) ||
                path
                  .replaceAll("\\", "/")
                  .split("/")
                  .some((part) => part === "" || part === "." || part === ".."),
            ))) ||
        (raw.timeoutMs !== undefined && (!Number.isSafeInteger(raw.timeoutMs) || (raw.timeoutMs as number) <= 0))
      ) {
        throw new Error(`${stageWhere} is invalid`);
      }
      ids.add(raw.id);
      return {
        id: raw.id,
        command: raw.command,
        ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
        ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
        ...(Array.isArray(raw.paths) ? { paths: raw.paths as string[] } : {}),
        ...(Array.isArray(raw.dependencyPaths) ? { dependencyPaths: raw.dependencyPaths as string[] } : {}),
        ...(typeof raw.cacheable === "boolean" ? { cacheable: raw.cacheable } : {}),
      };
    });
  }
  if (value.resume !== undefined) {
    if (!isRecord(value.resume)) throw new Error(`${where}.resume must be an object`);
    const resume: LoopResumeConfig = {
      expectedInitialStatus: loopStatus(value.resume.expectedInitialStatus, `${where}.resume.expectedInitialStatus`),
    };
    if (value.resume.additionalIterations !== undefined) {
      resume.additionalIterations = positiveInteger(
        value.resume.additionalIterations,
        `${where}.resume.additionalIterations`,
        MAX_LOOP_ITERATIONS - maxIterations,
      );
    }
    if (value.resume.additionalCostBudgetUsd !== undefined) {
      resume.additionalCostBudgetUsd = positiveNumber(
        value.resume.additionalCostBudgetUsd,
        `${where}.resume.additionalCostBudgetUsd`,
      );
    }
    for (const name of ["additionalTokenBudget", "additionalDurationMs", "additionalVerifyRuns"] as const) {
      if (value.resume[name] !== undefined) {
        resume[name] = positiveInteger(value.resume[name], `${where}.resume.${name}`);
      }
    }
    if (
      resume.additionalIterations === undefined &&
      resume.additionalCostBudgetUsd === undefined &&
      resume.additionalTokenBudget === undefined &&
      resume.additionalDurationMs === undefined &&
      resume.additionalVerifyRuns === undefined
    ) {
      throw new Error(`${where}.resume must add iterations or a budget dimension`);
    }
    loop.resume = resume;
  }
  if (loop.interruptAfterEvent !== undefined && loop.resume === undefined) {
    throw new Error(`${where}.interruptAfterEvent requires resume configuration`);
  }
  return loop;
}

function parseScenario(value: unknown, where: string): SessionScenarioConfig {
  if (!isRecord(value) || !Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error(`${where}.steps must be a non-empty array`);
  }
  const steps: SessionScenarioStep[] = [];
  const memoryKeys = new Set<string>();
  let hasPriorAgent = false;
  for (const [index, raw] of value.steps.entries()) {
    const stepWhere = `${where}.steps[${index}]`;
    if (!isRecord(raw)) throw new Error(`${stepWhere} must be an object`);
    switch (raw.type) {
      case "agent": {
        const step: Extract<SessionScenarioStep, { type: "agent" }> = { type: "agent" };
        if (raw.task !== undefined) step.task = requireString(raw, "task", stepWhere);
        if (raw.mode !== undefined) {
          if (raw.mode !== "ask" && raw.mode !== "edit") throw new Error(`${stepWhere}.mode must be "ask" or "edit"`);
          step.mode = raw.mode;
        }
        if (raw.resume !== undefined) {
          if (typeof raw.resume !== "boolean") throw new Error(`${stepWhere}.resume must be a boolean`);
          if (raw.resume && !hasPriorAgent) throw new Error(`${stepWhere}.resume requires an earlier agent step`);
          step.resume = raw.resume;
        }
        if (raw.expectedStatus !== undefined) {
          step.expectedStatus = expectedSessionStatus(raw.expectedStatus, `${stepWhere}.expectedStatus`);
        }
        steps.push(step);
        hasPriorAgent = true;
        break;
      }
      case "memory.add": {
        const key = requireString(raw, "key", stepWhere);
        if (memoryKeys.has(key)) throw new Error(`${stepWhere}.key duplicates memory alias ${key}`);
        const step: Extract<SessionScenarioStep, { type: "memory.add" }> = {
          type: "memory.add",
          key,
          content: requireString(raw, "content", stepWhere),
        };
        if (raw.memoryType !== undefined) {
          if (
            typeof raw.memoryType !== "string" ||
            !MEMORY_CANDIDATE_TYPES.includes(raw.memoryType as MemoryCandidateType)
          ) {
            throw new Error(`${stepWhere}.memoryType must be a valid memory candidate type`);
          }
          step.memoryType = raw.memoryType as MemoryCandidateType;
        }
        if (raw.approve !== undefined) {
          if (typeof raw.approve !== "boolean") throw new Error(`${stepWhere}.approve must be a boolean`);
          step.approve = raw.approve;
        }
        memoryKeys.add(key);
        steps.push(step);
        break;
      }
      case "memory.approve":
      case "memory.reject": {
        const key = requireString(raw, "key", stepWhere);
        if (!memoryKeys.has(key)) throw new Error(`${stepWhere}.key references unknown memory alias ${key}`);
        steps.push({ type: raw.type, key });
        break;
      }
      default:
        throw new Error(`${stepWhere}: unknown scenario step ${JSON.stringify(raw.type)}`);
    }
  }
  if (!hasPriorAgent) throw new Error(`${where}.steps must contain at least one agent step`);
  return { steps };
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
  const runner = value.runner ?? "agent";
  if (typeof runner !== "string" || !TASK_RUNNERS.includes(runner as TaskRunner)) {
    throw new Error(`${where}: "runner" must be agent, loop, or session_scenario`);
  }
  const task: TaskDef = {
    id: requireTaskId(value, where),
    title: requireString(value, "title", where),
    fixture: requireRelativePath(value, "fixture", where),
    mode,
    task: requireString(value, "task", where),
    checks: value.checks.map((c, i) => validateCheck(c, `${where} checks[${i}]`)),
  };
  if (value.runner !== undefined) task.runner = runner as TaskRunner;
  if (value.notes !== undefined) task.notes = requireString(value, "notes", where);
  if (value.provenance !== undefined) {
    if (!isRecord(value.provenance)) throw new Error(`${where}: "provenance" must be an object`);
    const kind = value.provenance.kind;
    if (kind !== "synthetic" && kind !== "dogfood" && kind !== "external") {
      throw new Error(`${where}: provenance.kind must be synthetic, dogfood, or external`);
    }
    const source = value.provenance.source;
    if (kind !== "synthetic" && (typeof source !== "string" || source.trim().length === 0)) {
      throw new Error(`${where}: ${kind} provenance must include a non-empty source`);
    }
    task.provenance = {
      kind,
      ...(typeof source === "string" && source.trim().length > 0 ? { source: source.trim() } : {}),
    };
  }

  if (runner === "agent") {
    if (value.loop !== undefined || value.scenario !== undefined) {
      throw new Error(`${where}: agent tasks cannot define loop or scenario config`);
    }
    if (value.expectedStatus !== undefined) {
      task.expectedStatus = expectedSessionStatus(value.expectedStatus, `${where}.expectedStatus`);
    }
  } else if (runner === "loop") {
    if (mode !== "edit") throw new Error(`${where}: loop tasks must use edit mode`);
    if (value.expectedStatus !== undefined || value.scenario !== undefined) {
      throw new Error(`${where}: loop tasks use loop.expectedStatus and cannot define scenario config`);
    }
    task.loop = parseLoop(value.loop, `${where}.loop`);
  } else {
    if (value.expectedStatus !== undefined || value.loop !== undefined) {
      throw new Error(`${where}: session_scenario tasks define terminal states per step`);
    }
    task.scenario = parseScenario(value.scenario, `${where}.scenario`);
  }
  return task;
}

/** Loads and validates all tasks in a directory, sorted by id. */
export function loadTasks(dir: string): TaskDef[] {
  const tasks: TaskDef[] = [];
  const entries: string[] = [];
  const handle = opendirSync(dir);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      entries.push(entry.name);
      if (entries.length > MAX_TASK_FILES) throw new Error(`task directory exceeds ${MAX_TASK_FILES} JSON files`);
    }
  } finally {
    handle.closeSync();
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    const parsed: unknown = JSON.parse(readTextFileBounded(file, MAX_TASK_FILE_BYTES));
    tasks.push(validateTask(parsed, entry));
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
  // Code points, not a collator: this order is the order tasks run in and the
  // order they appear in a persisted result file, which is then diffed against
  // another machine's.
  return tasks.sort((a, b) => compareByCodePoints(a.id, b.id));
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

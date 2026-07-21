import type { TaskResult } from "./task-runner.js";
import { TASK_RUNNERS, validateCheck } from "./tasks.js";
import { MAX_BASELINE_BYTES, MAX_BASELINE_RESULTS } from "./limits.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonnegative(value: unknown, where: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${where} must be a finite non-negative${integer ? " integer" : " number"}`);
  }
  return value;
}

function optionalMetric(value: unknown, where: string, integer = false): number | undefined {
  return value === undefined ? undefined : finiteNonnegative(value, where, integer);
}

function validateResult(value: unknown, where: string): TaskResult {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  if (typeof value["taskId"] !== "string" || value["taskId"].length === 0) {
    throw new Error(`${where}.taskId must be a non-empty string`);
  }
  if (typeof value["success"] !== "boolean") throw new Error(`${where}.success must be a boolean`);
  if (!Array.isArray(value["checks"])) throw new Error(`${where}.checks must be an array`);
  for (const [index, check] of value["checks"].entries()) {
    if (!isRecord(check) || !isRecord(check["check"]) || typeof check["passed"] !== "boolean") {
      throw new Error(`${where}.checks[${index}] must contain an object check and boolean passed`);
    }
    validateCheck(check["check"], `${where}.checks[${index}].check`);
    if (check["detail"] !== undefined && typeof check["detail"] !== "string") {
      throw new Error(`${where}.checks[${index}].detail must be a string`);
    }
  }
  const metrics = value["metrics"];
  if (!isRecord(metrics)) throw new Error(`${where}.metrics must be an object`);
  finiteNonnegative(metrics["toolCalls"], `${where}.metrics.toolCalls`, true);
  finiteNonnegative(metrics["failedToolCalls"], `${where}.metrics.failedToolCalls`, true);
  finiteNonnegative(metrics["costUsd"], `${where}.metrics.costUsd`);
  finiteNonnegative(metrics["durationMs"], `${where}.metrics.durationMs`);
  optionalMetric(metrics["turns"], `${where}.metrics.turns`, true);
  optionalMetric(metrics["score"], `${where}.metrics.score`);
  const tokenKeys = ["promptTokens", "completionTokens", "cacheHitTokens", "totalTokens"] as const;
  const presentTokenFields = tokenKeys.filter((key) => metrics[key] !== undefined).length;
  if (presentTokenFields !== 0 && presentTokenFields !== tokenKeys.length) {
    throw new Error(`${where}.metrics token fields must be all present or all absent`);
  }
  for (const key of tokenKeys) {
    optionalMetric(metrics[key], `${where}.metrics.${key}`, true);
  }
  if (
    typeof metrics["failedToolCalls"] === "number" &&
    typeof metrics["toolCalls"] === "number" &&
    metrics["failedToolCalls"] > metrics["toolCalls"]
  ) {
    throw new Error(`${where}.metrics.failedToolCalls must not exceed toolCalls`);
  }
  if (
    typeof metrics["cacheHitTokens"] === "number" &&
    typeof metrics["promptTokens"] === "number" &&
    metrics["cacheHitTokens"] > metrics["promptTokens"]
  ) {
    throw new Error(`${where}.metrics.cacheHitTokens must not exceed promptTokens`);
  }
  if (
    typeof metrics["totalTokens"] === "number" &&
    typeof metrics["promptTokens"] === "number" &&
    typeof metrics["completionTokens"] === "number" &&
    metrics["totalTokens"] !== metrics["promptTokens"] + metrics["completionTokens"]
  ) {
    throw new Error(`${where}.metrics.totalTokens must equal promptTokens + completionTokens`);
  }
  if (value["sample"] !== undefined) {
    const sample = finiteNonnegative(value["sample"], `${where}.sample`, true);
    if (sample < 1) throw new Error(`${where}.sample must be positive`);
  }
  if (value["error"] !== undefined && typeof value["error"] !== "string") {
    throw new Error(`${where}.error must be a string`);
  }
  if (value["execution"] !== undefined) {
    const execution = value["execution"];
    if (
      !isRecord(execution) ||
      typeof execution["runner"] !== "string" ||
      !TASK_RUNNERS.includes(execution["runner"] as (typeof TASK_RUNNERS)[number]) ||
      typeof execution["status"] !== "string" ||
      execution["status"].length === 0 ||
      typeof execution["expectedStatus"] !== "string" ||
      execution["expectedStatus"].length === 0 ||
      typeof execution["passed"] !== "boolean" ||
      !Array.isArray(execution["sessionIds"]) ||
      !execution["sessionIds"].every((id) => typeof id === "string" && id.length > 0)
    ) {
      throw new Error(`${where}.execution has an invalid orchestration shape`);
    }
    optionalMetric(execution["iterations"], `${where}.execution.iterations`, true);
    optionalMetric(execution["maxIterations"], `${where}.execution.maxIterations`, true);
    if (execution["resumed"] !== undefined && typeof execution["resumed"] !== "boolean") {
      throw new Error(`${where}.execution.resumed must be a boolean`);
    }
    if (execution["steps"] !== undefined && !Array.isArray(execution["steps"])) {
      throw new Error(`${where}.execution.steps must be an array`);
    }
  }
  if (value["skills"] !== undefined) {
    if (!Array.isArray(value["skills"])) throw new Error(`${where}.skills must be an array`);
    for (const [index, skill] of value["skills"].entries()) {
      if (
        !isRecord(skill) ||
        typeof skill["skillId"] !== "string" ||
        typeof skill["scope"] !== "string" ||
        typeof skill["score"] !== "number" ||
        !Number.isFinite(skill["score"])
      ) {
        throw new Error(`${where}.skills[${index}] has an invalid shape`);
      }
    }
  }
  return value as TaskResult;
}

export function parseBaseline(baselineJson: string): TaskResult[] {
  if (Buffer.byteLength(baselineJson, "utf8") > MAX_BASELINE_BYTES) {
    throw new Error(`baseline exceeds ${MAX_BASELINE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(baselineJson);
  } catch (error) {
    throw new Error(`baseline is not valid JSON: ${(error as Error).message}`);
  }
  let rawResults: unknown;
  if (Array.isArray(parsed)) rawResults = parsed;
  else if (isRecord(parsed)) rawResults = parsed["results"];
  if (!Array.isArray(rawResults)) {
    throw new Error("baseline JSON must be a report file ({results: [...]}) or an array of task results");
  }
  if (rawResults.length === 0) throw new Error("baseline results must not be empty");
  if (rawResults.length > MAX_BASELINE_RESULTS) {
    throw new Error(`baseline results exceed ${MAX_BASELINE_RESULTS} entries`);
  }
  return rawResults.map((result, index) => validateResult(result, `baseline.results[${index}]`));
}

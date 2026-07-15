import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_REPEAT } from "./args.js";
import { evalsDir } from "./paths.js";

export type GateConfig = {
  minSuccessRate: number;
  maxSuccessRateDrop: number;
  maxCostPerSuccessUsd: number;
  maxCostPerSuccessIncreaseRatio: number;
  maxTokensPerSuccess: number;
  maxTokensPerSuccessIncreaseRatio: number;
  maxToolFailureRate: number;
  maxToolFailureRateIncrease: number;
  maxSessionErrorRate: number;
};

export type SuiteConfig = {
  tasks: "*" | string[];
  repeat: number;
  gates: GateConfig;
};

export type EvalSuiteConfig = {
  version: 1;
  suites: Record<string, SuiteConfig>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(
  obj: Record<string, unknown>,
  key: keyof GateConfig,
  where: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = obj[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max)
  ) {
    const range = options.max === undefined ? `>= ${options.min ?? 0}` : `${options.min ?? 0}..${options.max}`;
    throw new Error(`${where}.${key} must be a finite number in ${range}`);
  }
  return value;
}

function parseGates(value: unknown, where: string): GateConfig {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  return {
    minSuccessRate: finiteNumber(value, "minSuccessRate", where, { min: 0, max: 1 }),
    maxSuccessRateDrop: finiteNumber(value, "maxSuccessRateDrop", where, { min: 0, max: 1 }),
    maxCostPerSuccessUsd: finiteNumber(value, "maxCostPerSuccessUsd", where, { min: 0 }),
    maxCostPerSuccessIncreaseRatio: finiteNumber(value, "maxCostPerSuccessIncreaseRatio", where, { min: 0 }),
    maxTokensPerSuccess: finiteNumber(value, "maxTokensPerSuccess", where, { min: 0 }),
    maxTokensPerSuccessIncreaseRatio: finiteNumber(value, "maxTokensPerSuccessIncreaseRatio", where, { min: 0 }),
    maxToolFailureRate: finiteNumber(value, "maxToolFailureRate", where, { min: 0, max: 1 }),
    maxToolFailureRateIncrease: finiteNumber(value, "maxToolFailureRateIncrease", where, { min: 0, max: 1 }),
    maxSessionErrorRate: finiteNumber(value, "maxSessionErrorRate", where, { min: 0, max: 1 }),
  };
}

function parseSuite(value: unknown, where: string): SuiteConfig {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const repeat = value["repeat"];
  if (!Number.isSafeInteger(repeat) || (repeat as number) < 1 || (repeat as number) > MAX_REPEAT) {
    throw new Error(`${where}.repeat must be an integer from 1 to ${MAX_REPEAT}`);
  }
  const rawTasks = value["tasks"];
  let tasks: "*" | string[];
  if (rawTasks === "*") {
    tasks = "*";
  } else if (
    Array.isArray(rawTasks) &&
    rawTasks.length > 0 &&
    rawTasks.every((task) => typeof task === "string" && task.length > 0)
  ) {
    tasks = [...new Set(rawTasks)];
  } else {
    throw new Error(`${where}.tasks must be "*" or a non-empty array of task ids`);
  }
  return { tasks, repeat: repeat as number, gates: parseGates(value["gates"], `${where}.gates`) };
}

export function parseSuiteConfig(value: unknown): EvalSuiteConfig {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["suites"])) {
    throw new Error("eval config must be an object with version 1 and a suites object");
  }
  const suites: Record<string, SuiteConfig> = {};
  for (const [name, suite] of Object.entries(value["suites"])) {
    if (name.length === 0) throw new Error("suite name must not be empty");
    suites[name] = parseSuite(suite, `suites.${name}`);
  }
  if (Object.keys(suites).length === 0) throw new Error("eval config must define at least one suite");
  return { version: 1, suites };
}

export function loadSuiteConfig(path: string = join(evalsDir, "config.json")): EvalSuiteConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot load eval suite config ${path}: ${(error as Error).message}`);
  }
  return parseSuiteConfig(parsed);
}

export function selectSuite(config: EvalSuiteConfig, name: string): SuiteConfig {
  const suite = config.suites[name];
  if (!suite) throw new Error(`unknown eval suite: ${name}`);
  return suite;
}

/**
 * Eval config loading, replicated from the CLI (the harness must not depend
 * on apps/cli). Precedence: env key > project .seekforge/config.json >
 * ~/.seekforge/config.json. The env key is provider-aware: ARK_API_KEY for an
 * `ark` provider, DEEPSEEK_API_KEY otherwise — so a DeepSeek user who exports
 * ARK_API_KEY for another tool never gets the Ark key sent to DeepSeek.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelPricing } from "@seekforge/core";
import { readTextFileBounded } from "./file-io.js";
import { MAX_EVAL_CONFIG_BYTES } from "./limits.js";

export type EvalConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Provider preset: "deepseek" (default) | "ark" | any preset name. Selects base URL + capabilities. */
  provider?: string;
  /**
   * User-supplied per-model price table (model id → { inputCacheMissPer1M,
   * inputCacheHitPer1M, outputPer1M } in USD per 1M tokens). Enables cost/budget
   * tracking on providers with no built-in price table (Ark, OpenAI, …); without
   * it cost stays 0 there.
   */
  modelPricing?: Record<string, ModelPricing>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelPricing(value: unknown): Record<string, ModelPricing> | undefined {
  if (!isRecord(value)) return undefined;
  const pricing: Record<string, ModelPricing> = {};
  for (const [model, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    const inputCacheMissPer1M = candidate["inputCacheMissPer1M"];
    const inputCacheHitPer1M = candidate["inputCacheHitPer1M"];
    const outputPer1M = candidate["outputPer1M"];
    if (
      typeof inputCacheMissPer1M !== "number" ||
      !Number.isFinite(inputCacheMissPer1M) ||
      inputCacheMissPer1M < 0 ||
      typeof inputCacheHitPer1M !== "number" ||
      !Number.isFinite(inputCacheHitPer1M) ||
      inputCacheHitPer1M < 0 ||
      typeof outputPer1M !== "number" ||
      !Number.isFinite(outputPer1M) ||
      outputPer1M < 0
    ) {
      continue;
    }
    pricing[model] = { inputCacheMissPer1M, inputCacheHitPer1M, outputPer1M };
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function readJson(path: string): EvalConfig {
  try {
    const parsed: unknown = JSON.parse(readTextFileBounded(path, MAX_EVAL_CONFIG_BYTES));
    if (!isRecord(parsed)) return {};
    const result: EvalConfig = {};
    for (const key of ["apiKey", "model", "baseUrl", "provider"] as const) {
      if (typeof parsed[key] === "string") result[key] = parsed[key];
    }
    const modelPricing = readModelPricing(parsed["modelPricing"]);
    if (modelPricing) result.modelPricing = modelPricing;
    return result;
  } catch {
    return {};
  }
}

export function loadEvalConfig(projectPath: string = process.cwd()): EvalConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(projectPath, ".seekforge", "config.json"));
  // Provider-aware env key: pick ARK_API_KEY only for an `ark` provider,
  // DEEPSEEK_API_KEY otherwise (default provider is "deepseek"). Higher layer
  // wins, matching the scalar merge below.
  const provider = (project.provider ?? global.provider ?? "deepseek").toLowerCase();
  const envApiKey = provider === "ark" ? process.env["ARK_API_KEY"] : process.env["DEEPSEEK_API_KEY"];
  return {
    ...global,
    ...project,
    ...(envApiKey ? { apiKey: envApiKey } : {}),
  };
}

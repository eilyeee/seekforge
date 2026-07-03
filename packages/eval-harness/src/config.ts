/**
 * Eval config loading, replicated from the CLI (the harness must not depend
 * on apps/cli). Precedence: env key > project .seekforge/config.json >
 * ~/.seekforge/config.json. The env key is provider-aware: ARK_API_KEY for an
 * `ark` provider, DEEPSEEK_API_KEY otherwise — so a DeepSeek user who exports
 * ARK_API_KEY for another tool never gets the Ark key sent to DeepSeek.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelPricing } from "@seekforge/core";

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

function readJson(path: string): EvalConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EvalConfig;
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

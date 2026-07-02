/**
 * Eval config loading, replicated from the CLI (the harness must not depend
 * on apps/cli). Precedence: env ARK_API_KEY > env DEEPSEEK_API_KEY > project
 * .seekforge/config.json > ~/.seekforge/config.json. ARK_API_KEY (Volcengine
 * Ark) wins when set; DEEPSEEK_API_KEY behaves exactly as before otherwise.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EvalConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Provider preset: "deepseek" (default) | "ark" | any preset name. Selects base URL + capabilities. */
  provider?: string;
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
  // ARK_API_KEY (Volcengine Ark) takes precedence when set; otherwise
  // DEEPSEEK_API_KEY behaves exactly as before for existing DeepSeek users.
  const envApiKey = process.env["ARK_API_KEY"] ?? process.env["DEEPSEEK_API_KEY"];
  return {
    ...global,
    ...project,
    ...(envApiKey ? { apiKey: envApiKey } : {}),
  };
}

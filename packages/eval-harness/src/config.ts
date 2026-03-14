/**
 * Eval config loading, replicated from the CLI (the harness must not depend
 * on apps/cli). Precedence: env DEEPSEEK_API_KEY > project .seekforge/config.json
 * > ~/.seekforge/config.json.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EvalConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
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
  return {
    ...global,
    ...project,
    ...(process.env["DEEPSEEK_API_KEY"] ? { apiKey: process.env["DEEPSEEK_API_KEY"] } : {}),
  };
}

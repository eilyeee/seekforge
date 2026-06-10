import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";

const ALLOWED_KEYS = ["apiKey", "model", "baseUrl", "runtimeBin", "commandAllowlist"] as const;

function configPath(global: boolean): string {
  const base = global ? homedir() : process.cwd();
  return join(base, ".seekforge", "config.json");
}

export function configShowCommand(): void {
  const merged = loadConfig(process.cwd());
  console.log(
    JSON.stringify(
      { ...merged, apiKey: merged.apiKey ? `${merged.apiKey.slice(0, 6)}****` : undefined },
      null,
      2,
    ),
  );
}

export function configSetCommand(key: string, value: string, opts: { global?: boolean }): void {
  if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
    console.error(`Unknown key "${key}". Allowed: ${ALLOWED_KEYS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const path = configPath(opts.global ?? false);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`warning: ${path} contained invalid JSON, rewriting`);
    }
  }
  // commandAllowlist is an array: accept comma-separated prefixes.
  current[key] =
    key === "commandAllowlist"
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : value;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  console.log(`set ${key} in ${path}`);
}

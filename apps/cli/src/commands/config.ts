import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { availableProfiles, loadConfig } from "../config.js";
import { t } from "../i18n.js";
import { writeStatePath } from "../project-state.js";

const ALLOWED_KEYS = [
  "apiKey",
  "model",
  "baseUrl",
  "provider",
  "runtimeBin",
  "commandAllowlist",
  "sandbox",
  "compaction",
  "thinking",
  "reasoningEffort",
] as const;

/** Allowed values for the enum-typed config keys. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  sandbox: ["off", "read-only", "workspace-write", "restricted"],
  compaction: ["mechanical", "llm"],
  reasoningEffort: ["high", "max"],
};

function configPath(global: boolean): string {
  const base = global ? homedir() : process.cwd();
  return join(base, ".seekforge", "config.json");
}

function parseConfigDoc(raw: string): Record<string, unknown> | null {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export function configShowCommand(): void {
  const merged = loadConfig(process.cwd());
  console.log(
    JSON.stringify({ ...merged, apiKey: merged.apiKey ? `${merged.apiKey.slice(0, 6)}****` : undefined }, null, 2),
  );
  const profiles = availableProfiles(process.cwd());
  if (profiles.length > 0) {
    console.log(`\nProfiles (use --profile <name>): ${profiles.join(", ")}`);
  }
}

export function configSetCommand(key: string, value: string, opts: { global?: boolean }): void {
  if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
    console.error(t("err.configSetUnknown", { key, allowed: ALLOWED_KEYS.join(", ") }));
    process.exitCode = 1;
    return;
  }
  const path = configPath(opts.global ?? false);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = parseConfigDoc(readFileSync(path, "utf8"));
      if (!parsed) throw new Error("config root must be an object");
      current = parsed;
    } catch {
      // Abort rather than clobber a config we couldn't parse — writing the
      // default {} back would silently drop every existing key.
      console.error(t("err.configInvalidJson", { path }));
      process.exitCode = 1;
      return;
    }
  }
  if (key === "commandAllowlist") {
    // Array of strings: accept comma-separated.
    current[key] = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (key === "thinking") {
    if (value !== "true" && value !== "false") {
      console.error(t("err.configSetBadValue", { key, allowed: "true, false" }));
      process.exitCode = 1;
      return;
    }
    current[key] = value === "true";
  } else if (key in ENUM_VALUES) {
    if (key === "reasoningEffort" && value.trim() === "") {
      delete current[key]; // clear → API default
    } else if (!ENUM_VALUES[key]!.includes(value)) {
      console.error(t("err.configSetBadValue", { key, allowed: ENUM_VALUES[key]!.join(", ") }));
      process.exitCode = 1;
      return;
    } else {
      current[key] = value;
    }
  } else {
    current[key] = value;
  }
  try {
    writeStatePath(path, `${JSON.stringify(current, null, 2)}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  console.log(t("cmd.config.setConfig", { key, path }));
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import { t } from "../i18n.js";

const ALLOWED_KEYS = [
  "apiKey",
  "model",
  "baseUrl",
  "runtimeBin",
  "commandAllowlist",
  "sandbox",
  "compaction",
  "thinking",
  "reasoningEffort",
] as const;

/** Allowed values for the enum-typed config keys. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  sandbox: ["off", "workspace-write", "restricted"],
  compaction: ["mechanical", "llm"],
  reasoningEffort: ["high", "max"],
};

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
    console.error(t("err.configSetUnknown", { key, allowed: ALLOWED_KEYS.join(", ") }));
    process.exitCode = 1;
    return;
  }
  const path = configPath(opts.global ?? false);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(t("err.configInvalidJson", { path }));
    }
  }
  if (key === "commandAllowlist") {
    // Array of prefixes: accept comma-separated.
    current[key] = value.split(",").map((s) => s.trim()).filter(Boolean);
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  console.log(t("cmd.config.setConfig", { key, path }));
}

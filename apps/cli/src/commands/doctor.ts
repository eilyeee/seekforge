// `seekforge doctor` — environment diagnostics for the CLI.
//
// The engine (DoctorCheck/DoctorProbes, the base probe bag, the shared
// checks, configKeysCheck/configParseCheck, the formatDoctorLines renderer)
// lives in @seekforge/shared/doctor; this module keeps the CLI's composition —
// its own wording (the `diff` affordance, the `config set` api-key hint, the
// docs/configuration.md typo hint, colored/localized rendering), the extended
// probe bag, the unrecognized-provider warning and the desktop/GUI checks.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_BASE_URL, resolveProviderPreset } from "@seekforge/core";
import {
  apiKeyCheck,
  clipboardCheck,
  configKeysCheck as sharedConfigKeysCheck,
  configParseCheck,
  createDefaultProbes as createBaseProbes,
  editorCheck,
  formatDoctorLines as sharedFormatDoctorLines,
  gitRepoCheck,
  mcpServersCheck,
  nodeCheck,
  platformCheck,
  projectConfigCheck,
  providerCheck,
  rustRuntimeCheck,
  sessionsCheck,
  type DoctorCheck,
  type DoctorProbes as BaseDoctorProbes,
} from "@seekforge/shared/doctor";
import { dim, green, red, yellow } from "../colors.js";
import { t } from "../i18n.js";
import { configParseErrors, loadConfig, unknownConfigKeys } from "../config.js";

export type { DoctorCheck };
export { configParseCheck };

/** The shared probe bag plus the CLI's desktop/GUI probes. */
export type DoctorProbes = BaseDoctorProbes & {
  /** Absolute path of `bin` resolved on PATH, or null. Never throws. */
  which: (bin: string) => string | null;
  /**
   * Repo root (a dir containing pnpm-workspace.yaml) found by walking up from
   * `start`, or null when not inside the monorepo (e.g. installed package).
   */
  findRepoRoot: (start: string) => string | null;
  /** Basenames matching `glob` (a single `*` wildcard) in `dir`, or [] / null. */
  glob: (dir: string, pattern: string) => string[] | null;
  /** File contents as UTF-8, or null when unreadable. Never throws. */
  readText: (path: string) => string | null;
};

export function createDefaultProbes(): DoctorProbes {
  return {
    ...createBaseProbes(),
    which: (bin) => {
      try {
        const r = spawnSync("which", [bin], { encoding: "utf8" });
        if (r.status !== 0) return null;
        const out = (r.stdout ?? "").trim().split("\n")[0]?.trim();
        return out ? out : null;
      } catch {
        return null;
      }
    },
    findRepoRoot: (start) => {
      try {
        let dir = start;
        for (let i = 0; i < 64; i++) {
          if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
          const parent = dirname(dir);
          if (parent === dir) return null;
          dir = parent;
        }
        return null;
      } catch {
        return null;
      }
    },
    glob: (dir, pattern) => {
      try {
        const star = pattern.indexOf("*");
        const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
        const suffix = star >= 0 ? pattern.slice(star + 1) : "";
        return readdirSync(dir).filter((name) =>
          star < 0 ? name === pattern : name.startsWith(prefix) && name.endsWith(suffix),
        );
      } catch {
        return null;
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Global-bin locations the macOS desktop shell appends to PATH before searching
 * for `seekforge`, because GUI apps inherit a minimal launchd PATH that omits
 * where `npm i -g` installs. Kept in sync with
 * apps/desktop/src-tauri/README.md ("How the serve command is resolved").
 */
const GUI_PATH_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "~/.npm-global/bin",
  "~/.local/bin",
  "~/.volta/bin",
  "~/.yarn/bin",
  "~/.bun/bin",
  "~/.nvm/versions/node/*/bin",
];

/** Base64 placeholder pubkey that marks the Tauri updater as disabled. */
const DISABLED_UPDATER_PUBKEY = "dW50cnVzdGVkIGNvbW1lbnQ6IHVwZGF0ZXIgZGlzYWJsZWQ=";

/** Runs every diagnostic. Pure given the probes (no direct fs/env access). */
export function runDoctor(
  projectPath: string,
  config: {
    apiKey?: string;
    provider?: string;
    baseUrl?: string;
    runtimeBin?: string;
    mcpServers?: Record<string, unknown>;
  },
  probes: DoctorProbes,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // Active provider preset (default "deepseek"); an explicit baseUrl always wins.
  const provider = (config.provider ?? "deepseek").toLowerCase();
  const preset = resolveProviderPreset(provider);
  const baseUrl = config.baseUrl ?? preset?.baseUrl ?? DEFAULT_BASE_URL;
  // An explicitly-set provider that resolves to no preset (a typo like "arkk")
  // and has no explicit baseUrl to fall back on silently uses the DeepSeek
  // endpoint — warn so it isn't mistaken for a working custom provider.
  // (CLI-only; the TUI shows the plain line either way.)
  const unrecognizedProvider =
    config.provider !== undefined && provider !== "deepseek" && !preset && config.baseUrl === undefined;
  checks.push(
    unrecognizedProvider
      ? {
          name: "provider",
          ok: true,
          warn: true,
          detail: `${provider} unrecognized — falling back to DeepSeek (${baseUrl})`,
          fixHint: "set a known provider (deepseek/ark) or an explicit baseUrl",
        }
      : providerCheck(provider, baseUrl),
  );

  checks.push(
    apiKeyCheck(
      provider,
      config.apiKey,
      probes.env,
      (keyEnv) => `export ${keyEnv}, or \`seekforge config set apiKey <key>\``,
    ),
  );
  checks.push(nodeCheck(probes));
  checks.push(platformCheck(probes));
  checks.push(gitRepoCheck(projectPath, probes, "`diff`"));
  checks.push(projectConfigCheck(projectPath, probes));
  checks.push(rustRuntimeCheck(config.runtimeBin, probes));
  checks.push(mcpServersCheck(config.mcpServers));
  checks.push(sessionsCheck(projectPath, probes));
  checks.push(editorCheck(probes, "$EDITOR/$VISUAL unset — external edit unavailable"));
  checks.push(clipboardCheck(probes));

  // Best-effort desktop/GUI diagnostics. Each is wrapped so a probe surprise
  // can never abort the whole report; a thrown probe degrades to a warn line.
  for (const make of [seekforgeOnPathCheck, sidecarCheck, webDistCheck, updaterCheck]) {
    try {
      const c = make(projectPath, probes);
      if (c) checks.push(c);
    } catch {
      checks.push({ name: "desktop", ok: true, warn: true, detail: "diagnostic skipped (probe error)" });
    }
  }

  return checks;
}

/**
 * Whether `seekforge` resolves on PATH. This is the "GUI app can't find
 * seekforge" diagnostic: the macOS desktop shell augments PATH with the
 * GUI_PATH_DIRS before searching, so we note them when the binary is missing.
 */
function seekforgeOnPathCheck(_projectPath: string, probes: DoctorProbes): DoctorCheck {
  const resolved = probes.which("seekforge");
  if (resolved) return { name: "seekforge on PATH", ok: true, detail: resolved };
  return {
    name: "seekforge on PATH",
    ok: true,
    warn: true,
    detail: "not on PATH — the desktop app augments PATH with these GUI-bin dirs before searching",
    fixHint: `ensure one of: ${GUI_PATH_DIRS.join(", ")}`,
  };
}

/**
 * Desktop sidecar binary (binaries/seekforge-server-<target-triple>). Only
 * meaningful inside the monorepo; outside it (installed package) we skip.
 */
function sidecarCheck(projectPath: string, probes: DoctorProbes): DoctorCheck | null {
  const root = probes.findRepoRoot(projectPath);
  if (!root) return null; // not in the monorepo — nothing to diagnose
  const dir = join(root, "apps", "desktop", "src-tauri", "binaries");
  const matches = probes.glob(dir, "seekforge-server-*");
  if (matches && matches.length > 0) {
    return { name: "desktop sidecar", ok: true, detail: matches.join(", ") };
  }
  return {
    name: "desktop sidecar",
    ok: true,
    warn: true,
    detail: "not built (~70 MB, rebuilt per release)",
    fixHint: "pnpm --filter seekforge build:sidecar",
  };
}

/** Prebuilt web workbench the desktop shell serves (apps/desktop/dist/index.html). */
function webDistCheck(projectPath: string, probes: DoctorProbes): DoctorCheck | null {
  const root = probes.findRepoRoot(projectPath);
  if (!root) return null;
  const indexHtml = join(root, "apps", "desktop", "dist", "index.html");
  if (probes.fileExists(indexHtml)) return { name: "web dist", ok: true, detail: indexHtml };
  return {
    name: "web dist",
    ok: true,
    warn: true,
    detail: "apps/desktop/dist/index.html missing",
    fixHint: "pnpm --filter @seekforge/desktop build",
  };
}

/**
 * Tauri updater status from tauri.conf.json: reports createUpdaterArtifacts and
 * whether the updater pubkey is the disabled placeholder.
 */
function updaterCheck(projectPath: string, probes: DoctorProbes): DoctorCheck | null {
  const root = probes.findRepoRoot(projectPath);
  if (!root) return null;
  const confPath = join(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
  const raw = probes.readText(confPath);
  if (raw === null) return null; // no desktop conf — skip gracefully
  let conf: {
    bundle?: { createUpdaterArtifacts?: boolean };
    plugins?: { updater?: { pubkey?: string } };
  };
  try {
    conf = JSON.parse(raw);
  } catch {
    return { name: "updater", ok: true, warn: true, detail: "tauri.conf.json unparseable" };
  }
  if (typeof conf !== "object" || conf === null || Array.isArray(conf)) {
    return { name: "updater", ok: true, warn: true, detail: "tauri.conf.json must contain an object" };
  }
  const artifacts = conf.bundle?.createUpdaterArtifacts === true;
  const pubkey = conf.plugins?.updater?.pubkey ?? "";
  const disabled = pubkey === DISABLED_UPDATER_PUBKEY;
  if (disabled || !artifacts) {
    return {
      name: "updater",
      ok: true,
      warn: true,
      detail: `disabled (createUpdaterArtifacts: ${artifacts}${disabled ? ", placeholder pubkey" : ""})`,
    };
  }
  return { name: "updater", ok: true, detail: "enabled (createUpdaterArtifacts: true)" };
}

/** Shared check with the CLI's fix-hint wording (points at docs/configuration.md). */
export function configKeysCheck(unknownKeys: string[]): DoctorCheck {
  return sharedConfigKeysCheck(unknownKeys, "check for typos — see docs/configuration.md for valid keys");
}

/** Shared renderer with the CLI's colored marks and localized hint/summary lines. */
export function formatDoctorLines(checks: DoctorCheck[]): string[] {
  return sharedFormatDoctorLines(checks, {
    mark: (mark) => (mark === "✗" ? red(mark) : mark === "~" ? yellow(mark) : green(mark)),
    fixHint: (hint) => dim(t("cmd.doctor.fixHint", { hint })),
    summary: (passed, total) => t("cmd.doctor.checksHeader", { passed, total }),
  });
}

/** `seekforge doctor` entry point. Exit code 1 if any check failed (warnings do not fail). */
export function doctorCommand(): void {
  const projectPath = process.cwd();
  const config = loadConfig(projectPath);
  const checks = runDoctor(projectPath, config, createDefaultProbes());
  checks.push(configParseCheck(configParseErrors(projectPath)));
  checks.push(configKeysCheck(unknownConfigKeys(projectPath)));
  for (const line of formatDoctorLines(checks)) console.log(line);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

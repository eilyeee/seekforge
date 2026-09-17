// `seekforge doctor` — environment diagnostics for the CLI.
//
// The engine (DoctorCheck/DoctorProbes, the base probe bag, the shared
// checks, configKeysCheck/configParseCheck, the formatDoctorLines renderer)
// lives in @seekforge/shared/doctor; this module keeps the CLI's composition —
// its own wording (the `diff` affordance, the `config set` api-key hint, the
// docs/configuration.md typo hint, colored/localized rendering), the extended
// probe bag, the unrecognized-provider warning and the desktop/GUI checks.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  astBackendInstalled,
  browserBackendInstalled,
  DEFAULT_BASE_URL,
  lspServerCommands,
  probeSandboxCapabilities,
  resolveProviderPreset,
} from "@seekforge/core";
import {
  apiKeyCheck,
  browserCheck,
  clipboardCheck,
  codeParsingCheck,
  configKeysCheck as sharedConfigKeysCheck,
  configParseCheck,
  createDefaultProbes as createBaseProbes,
  dockerCheck,
  editorCheck,
  formatDoctorLines as sharedFormatDoctorLines,
  gitRepoCheck,
  lspServersCheck,
  mcpServersCheck,
  osSandboxCheck,
  nodeCheck,
  platformCheck,
  projectConfigCheck,
  providerCheck,
  rustRuntimeCheck,
  sessionsCheck,
  type DoctorCheck,
  type DoctorStrings,
  type DoctorProbes as BaseDoctorProbes,
} from "@seekforge/shared/doctor";
import { dim, green, red, yellow } from "../colors.js";
import { t } from "../i18n.js";
import type { ConfigKeyVerdict } from "@seekforge/shared/config-manifest";
import { configParseErrors, loadConfig, unknownConfigKeys } from "../config.js";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "../bounded-file.js";

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
  /** Whether this Node can route fetch through HTTP(S)_PROXY (built-in env proxy support). */
  nodeSupportsEnvProxy?: () => boolean;
  /** Flags this Node process was started with. */
  execArgv?: () => string[];
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
        return readTextFileBounded(path, MAX_CONFIG_FILE_BYTES);
      } catch {
        return null;
      }
    },
    // The flag's presence in allowedNodeEnvironmentFlags is the capability
    // itself (it arrived in a 22.x backport); 24.0 honored the env var first.
    nodeSupportsEnvProxy: () =>
      process.allowedNodeEnvironmentFlags.has("--use-env-proxy") || Number.parseInt(process.versions.node, 10) >= 24,
    execArgv: () => process.execArgv,
  };
}

// Node's built-in support reads these and NO_PROXY; ALL_PROXY is not among them.
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

const PROXY_SCHEMES = new Set(["http:", "https:", "socks:", "socks4:", "socks5:", "socks5h:"]);

/**
 * A proxy URL fit to print: credentials replaced, anything else withheld —
 * `user:pw@host` parses as a URL whose scheme is `user:`, so parsing alone is
 * not a license to echo the value.
 */
export function redactProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!PROXY_SCHEMES.has(url.protocol)) return "(set, not a URL)";
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "(set, not a URL)";
  }
}

/**
 * Proxy variables versus what this Node does with them. Informational: a
 * proxy the runtime ignores is worth knowing about, but not a failure.
 */
export function proxyCheck(probes: DoctorProbes): DoctorCheck {
  const set = PROXY_VARS.filter((key) => probes.env(key));
  if (set.length === 0) {
    const allProxy = probes.env("ALL_PROXY") ?? probes.env("all_proxy");
    return {
      name: "proxy",
      ok: true,
      detail: allProxy ? "no HTTP(S)_PROXY set (ALL_PROXY is set, but node does not read it)" : "no HTTP(S)_PROXY set",
    };
  }
  const shown = set.map((key) => `${key}=${redactProxyUrl(probes.env(key) ?? "")}`).join(", ");
  const noProxy = probes.env("NO_PROXY") ?? probes.env("no_proxy");
  const suffix = noProxy ? `; NO_PROXY=${noProxy}` : "";
  const supported = probes.nodeSupportsEnvProxy?.() ?? false;
  const enabled =
    probes.env("NODE_USE_ENV_PROXY") === "1" ||
    /(^|\s)--use-env-proxy(\s|$)/.test(probes.env("NODE_OPTIONS") ?? "") ||
    (probes.execArgv?.() ?? []).includes("--use-env-proxy");
  if (!supported) {
    return {
      name: "proxy",
      ok: true,
      warn: true,
      detail: `${shown}${suffix} — node ${probes.nodeVersion()} has no built-in proxy support, so requests go direct`,
      fixHint: "use a Node release with built-in proxy support (24+, or a recent 22.x)",
    };
  }
  if (!enabled) {
    return {
      name: "proxy",
      ok: true,
      detail: `${shown}${suffix} — this node can honor it, but NODE_USE_ENV_PROXY is not set`,
      fixHint: "export NODE_USE_ENV_PROXY=1 (or NODE_OPTIONS=--use-env-proxy) to send requests through the proxy",
    };
  }
  return { name: "proxy", ok: true, detail: `${shown}${suffix} (honored by node)` };
}

/** pdftotext (poppler) on PATH. Informational: only PDF text extraction needs it. */
export function pdftotextCheck(probes: DoctorProbes): DoctorCheck {
  const resolved = probes.which("pdftotext");
  if (resolved) return { name: "pdftotext", ok: true, detail: resolved };
  return {
    name: "pdftotext",
    ok: true,
    detail: "not on PATH — PDF text extraction unavailable",
    fixHint: "brew install poppler (macOS) / apt install poppler-utils (Debian/Ubuntu)",
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

/**
 * The CLI's localized text for the shared checks.
 *
 * Every one of these keys already existed in both languages and was never
 * read: the checks moved into @seekforge/shared and the translations did not
 * follow, so `seekforge doctor` printed English details beneath a Chinese
 * header. Resolved per call rather than once at module load because `t`
 * depends on the locale, which the config can change between invocations.
 */
function doctorStrings(): DoctorStrings {
  return {
    configured: t("cmd.doctor.checkConfigured"),
    missing: t("cmd.doctor.checkMissing"),
    gitPresent: t("cmd.doctor.checkPresent"),
    noGitRepo: () => t("cmd.doctor.checkNoGitRepo"),
    projectConfig: t("cmd.doctor.checkProjectConfig"),
    usingDefaults: t("cmd.doctor.checkUsingDefaults"),
    runtimeNotConfigured: t("cmd.doctor.checkRuntimeNotConfigured"),
    runtimeNotFound: (path) => t("cmd.doctor.checkRuntimeNotFound", { path }),
    mcpCount: (count) => t("cmd.doctor.checkMcpCount", { count: String(count) }),
    noSessions: t("cmd.doctor.checkNoSessions"),
    sessionCount: (count) => t("cmd.doctor.checkSessionCount", { count: String(count) }),
    noClipboard: t("cmd.doctor.checkNoClipboard"),
    allRecognized: t("cmd.doctor.checkKeysAllRecognized"),
    unrecognized: (keys) => t("cmd.doctor.checkKeysUnrecognized", { keys }),
    readElsewhere: (keys) => t("cmd.doctor.checkKeysElsewhere", { keys }),
  };
}
/** Runs every diagnostic. Pure given the probes (no direct fs/env access). */
export function runDoctor(
  projectPath: string,
  config: {
    apiKey?: string;
    provider?: string;
    baseUrl?: string;
    runtimeBin?: string;
    mcpServers?: Record<string, unknown>;
    sandbox?: string;
  },
  probes: DoctorProbes,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const strings = doctorStrings();
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
      strings,
    ),
  );
  checks.push(nodeCheck(probes));
  checks.push(platformCheck(probes));
  checks.push(gitRepoCheck(projectPath, probes, "`diff`", strings));
  checks.push(projectConfigCheck(projectPath, probes, strings));
  checks.push(rustRuntimeCheck(config.runtimeBin, probes, strings));
  checks.push(mcpServersCheck(config.mcpServers, strings));
  checks.push(sessionsCheck(projectPath, probes, strings));
  checks.push(editorCheck(probes, t("cmd.doctor.checkEditorUnset")));
  checks.push(clipboardCheck(probes, strings));

  // Optional subsystems. Each degrades QUIETLY when absent — which is exactly
  // what a diagnostic is for — and none of them fails the report.
  const configuredSandbox = config.sandbox !== undefined && config.sandbox !== "off";
  checks.push(osSandboxCheck(probeSandboxCapabilities(probes.platform()), configuredSandbox));
  checks.push(browserCheck(browserBackendInstalled()));
  checks.push(lspServersCheck(probes, lspServerCommands()));
  checks.push(codeParsingCheck(astBackendInstalled()));
  checks.push(dockerCheck(probes));
  checks.push(pdftotextCheck(probes));
  checks.push(proxyCheck(probes));

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
export function configKeysCheck(keys: ConfigKeyVerdict[]): DoctorCheck {
  return sharedConfigKeysCheck(keys, t("cmd.doctor.checkKeysFixHint"), doctorStrings());
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

/**
 * Doctor framework — the diagnostic engine and the checks that are genuinely
 * identical between `seekforge doctor` (apps/cli/src/commands/doctor.ts) and
 * the TUI's /doctor (apps/tui/src/doctor.ts), which used to be parallel
 * reimplementations.
 *
 * Split of responsibilities:
 *   - here: DoctorCheck/DoctorProbes shapes, the base real-OS probe bag,
 *     clipboardCandidates, the shared check builders, configKeysCheck /
 *     configParseCheck, and the formatDoctorLines rendering engine;
 *   - apps: their runDoctor composition (each has app-only checks — the TUI's
 *     project-memory line, the CLI's desktop/GUI diagnostics and its
 *     unrecognized-provider warning), extra probes (the CLI extends the bag
 *     with which/findRepoRoot/glob/readText), and any DELIBERATELY different
 *     user-visible wording, passed in as parameters so doctor output stays
 *     byte-identical per app (it is asserted in both apps' tests).
 *
 * NODE-ONLY (spawnSync/fs in createDefaultProbes), so it lives behind the
 * "./doctor" subpath export and is NOT re-exported from index.ts (the package
 * root must stay browser-safe for the desktop bundle).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConfigKeyVerdict } from "./config-manifest.js";
import { apiKeyEnvVar } from "./provider-env.js";

/**
 * A single diagnostic result rendered as one line by formatDoctorLines.
 * `ok: false` is a failure (✗); `ok: true` with `warn: true` is a non-fatal
 * warning (~) that does not flip the summary / exit code.
 */
export type DoctorCheck = { name: string; ok: boolean; warn?: boolean; detail: string; fixHint?: string };

/**
 * System probes injected into the checks; swap with fakes in tests. This is
 * the base bag shared by both apps — the CLI extends it with its desktop
 * probes (which/findRepoRoot/glob/readText).
 */
export type DoctorProbes = {
  env: (key: string) => string | undefined;
  fileExists: (path: string) => boolean;
  nodeVersion: () => string;
  platform: () => string;
  commandExists: (bin: string) => boolean;
  /** Entry count of a directory, or null when it does not exist. */
  countDir: (path: string) => number | null;
};

/** Real-OS probes used by the apps; tests should build their own fakes. */
export function createDefaultProbes(): DoctorProbes {
  return {
    env: (key) => process.env[key],
    fileExists: (path) => existsSync(path),
    nodeVersion: () => process.version,
    platform: () => process.platform,
    commandExists: (bin) => {
      try {
        return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
      } catch {
        return false;
      }
    },
    countDir: (path) => {
      try {
        return readdirSync(path).length;
      } catch {
        return null;
      }
    },
  };
}

/** Clipboard binaries probed per platform (first hit wins). */
export function clipboardCandidates(platform: string): string[] {
  return platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"];
}

// ---------------------------------------------------------------------------
// Shared check builders. The caller resolves provider/baseUrl itself (that
// needs core's preset table, which shared must not depend on) and passes any
// app-specific wording in explicitly.
// ---------------------------------------------------------------------------

/**
 * User-visible text for the shared checks, so a localized frontend can supply
 * its own without reimplementing the check.
 *
 * These checks were moved here when the CLI and the TUI stopped being parallel
 * reimplementations — and the CLI's Chinese translations for them stayed
 * behind, written and unreachable. `seekforge doctor` therefore printed English
 * details under a Chinese header and a Chinese fix-hint prefix. Every field is
 * optional and defaults to the English that was hardcoded here, so the
 * English-only TUI passes nothing and its output is unchanged.
 */
export type DoctorStrings = {
  configured?: string;
  missing?: string;
  gitPresent?: string;
  /** `diffLabel` is the app's diff affordance: "`diff`" (CLI) / "/diff" (TUI). */
  noGitRepo?: (diffLabel: string) => string;
  projectConfig?: string;
  usingDefaults?: string;
  runtimeNotConfigured?: string;
  runtimeNotFound?: (bin: string) => string;
  mcpCount?: (count: number) => string;
  noSessions?: string;
  sessionCount?: (count: number) => string;
  noClipboard?: string;
  allRecognized?: string;
  unrecognized?: (keys: string) => string;
  readElsewhere?: (keys: string) => string;
};

/** The plain "provider (baseUrl)" line (the CLI wraps this with its own warn branch). */
export function providerCheck(provider: string, baseUrl: string): DoctorCheck {
  return { name: "provider", ok: true, detail: `${provider} (${baseUrl})` };
}

/**
 * The right key satisfies the check: the provider's own variable when it has
 * one (see provider-env.ts), DEEPSEEK_API_KEY otherwise; an explicit apiKey in
 * config works for any of them. The missing-key fix hint differs per app
 * (setup-wizard vs `config set`) so it is built by the caller from the env-var
 * name.
 */
export function apiKeyCheck(
  provider: string,
  apiKey: string | undefined,
  env: DoctorProbes["env"],
  missingFixHint: (keyEnv: string) => string,
  strings: DoctorStrings = {},
): DoctorCheck {
  const keyEnv = apiKeyEnvVar(provider);
  const hasKey = Boolean(apiKey ?? env(keyEnv));
  return hasKey
    ? { name: "api key", ok: true, detail: strings.configured ?? "configured" }
    : { name: "api key", ok: false, detail: strings.missing ?? "missing", fixHint: missingFixHint(keyEnv) };
}

export function nodeCheck(probes: DoctorProbes): DoctorCheck {
  const version = probes.nodeVersion();
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  return Number.isFinite(major) && major >= 20
    ? { name: "node", ok: true, detail: `${version} (>= 20)` }
    : {
        name: "node",
        ok: false,
        detail: `${version} — SeekForge requires node >= 20`,
        fixHint: "nvm install 22 && nvm use 22",
      };
}

export function platformCheck(probes: DoctorProbes): DoctorCheck {
  return { name: "platform", ok: true, detail: probes.platform() };
}

/** `diffLabel` is the app's diff affordance: "`diff`" (CLI) / "/diff" (TUI). */
export function gitRepoCheck(
  projectPath: string,
  probes: DoctorProbes,
  diffLabel: string,
  strings: DoctorStrings = {},
): DoctorCheck {
  return probes.fileExists(join(projectPath, ".git"))
    ? { name: "git repo", ok: true, detail: strings.gitPresent ?? ".git present" }
    : {
        name: "git repo",
        ok: false,
        detail: strings.noGitRepo?.(diffLabel) ?? `not a git repository — checkpoints and ${diffLabel} are limited`,
        fixHint: "git init",
      };
}

export function projectConfigCheck(
  projectPath: string,
  probes: DoctorProbes,
  strings: DoctorStrings = {},
): DoctorCheck {
  return probes.fileExists(join(projectPath, ".seekforge", "config.json"))
    ? { name: "project config", ok: true, detail: strings.projectConfig ?? ".seekforge/config.json" }
    : { name: "project config", ok: true, detail: strings.usingDefaults ?? "using global defaults" };
}

export function rustRuntimeCheck(
  runtimeBin: string | undefined,
  probes: DoctorProbes,
  strings: DoctorStrings = {},
): DoctorCheck {
  if (!runtimeBin) {
    return { name: "rust runtime", ok: true, detail: strings.runtimeNotConfigured ?? "not configured (TS fallback)" };
  }
  return probes.fileExists(runtimeBin)
    ? { name: "rust runtime", ok: true, detail: runtimeBin }
    : {
        name: "rust runtime",
        ok: false,
        detail: strings.runtimeNotFound?.(runtimeBin) ?? `${runtimeBin} not found`,
        fixHint: "fix runtimeBin in config.json or remove it (TS fallback works)",
      };
}

export function mcpServersCheck(
  mcpServers: Record<string, unknown> | undefined,
  strings: DoctorStrings = {},
): DoctorCheck {
  const mcpCount = Object.keys(mcpServers ?? {}).length;
  return { name: "mcp servers", ok: true, detail: strings.mcpCount?.(mcpCount) ?? `${mcpCount} configured` };
}

export function sessionsCheck(projectPath: string, probes: DoctorProbes, strings: DoctorStrings = {}): DoctorCheck {
  const sessions = probes.countDir(join(projectPath, ".seekforge", "sessions"));
  const detail =
    sessions === null
      ? (strings.noSessions ?? "no sessions yet")
      : (strings.sessionCount?.(sessions) ?? `${sessions} recorded`);
  return { name: "sessions", ok: true, detail };
}

/** `missingDetail` differs per app ("ctrl-e external edit" vs "external edit"). */
export function editorCheck(probes: DoctorProbes, missingDetail: string): DoctorCheck {
  const editor = probes.env("EDITOR") ?? probes.env("VISUAL");
  return editor ? { name: "editor", ok: true, detail: editor } : { name: "editor", ok: false, detail: missingDetail };
}

export function clipboardCheck(probes: DoctorProbes, strings: DoctorStrings = {}): DoctorCheck {
  const clip = clipboardCandidates(probes.platform()).find((bin) => probes.commandExists(bin));
  return clip
    ? { name: "clipboard", ok: true, detail: clip }
    : {
        name: "clipboard",
        ok: false,
        detail: strings.noClipboard ?? "no clipboard tool found (pbcopy/wl-copy/xclip)",
      };
}

/**
 * Warns about unrecognized config keys (typos silently ignored otherwise). A
 * warning, not a failure — an unknown key is harmless, just probably a
 * mistake. The default fix hint is the TUI wording; the CLI passes its own
 * (pointing at docs/configuration.md).
 *
 * Accepts either the plain list of keys this surface did not recognize (the
 * older shape, kept for callers that have nothing better) or the classified
 * verdicts from classifyConfigKeys, which can tell a typo from a key another
 * frontend honors. Only the first is a warning: `models` is a real Desktop
 * setting, and reporting it as a probable typo to a CLI user is the diagnostic
 * being wrong about working configuration.
 */
export function configKeysCheck(
  keys: string[] | ConfigKeyVerdict[],
  fixHint = "check for typos — see the config docs for valid keys",
  strings: DoctorStrings = {},
): DoctorCheck {
  const verdicts: ConfigKeyVerdict[] = keys.map((entry) =>
    typeof entry === "string" ? { key: entry, kind: "unknown" } : entry,
  );
  const unknown = verdicts.filter((v) => v.kind === "unknown").map((v) => v.key);
  const elsewhere = verdicts.filter(
    (v): v is Extract<ConfigKeyVerdict, { kind: "other-surface" }> => v.kind !== "unknown",
  );
  const elsewhereDetail = elsewhere.map((v) => `${v.key} (${v.surfaces.join("/")})`).join(", ");

  const allRecognized = strings.allRecognized ?? "all recognized";
  const elsewherePhrase =
    elsewhere.length === 0
      ? ""
      : `; ${strings.readElsewhere?.(elsewhereDetail) ?? `read by another frontend: ${elsewhereDetail}`}`;

  if (unknown.length === 0) {
    return { name: "config keys", ok: true, detail: `${allRecognized}${elsewherePhrase}` };
  }
  const unknownPhrase = strings.unrecognized?.(unknown.join(", ")) ?? `unrecognized: ${unknown.join(", ")}`;
  return { name: "config keys", ok: true, warn: true, detail: `${unknownPhrase}${elsewherePhrase}`, fixHint };
}

/**
 * Fails when an existing config.json layer is syntactically broken or is not a
 * JSON object. `readJson` collapses either case to `{}`, so without this check a
 * malformed config silently drops every setting AND doctor reports clean.
 */
export function configParseCheck(errors: string[]): DoctorCheck {
  if (errors.length === 0) return { name: "config parse", ok: true, detail: "all config files are valid" };
  return {
    name: "config parse",
    ok: false,
    detail: `invalid: ${errors.join(", ")}`,
    fixHint: "use a valid JSON object",
  };
}

/** Rendering hooks so the CLI can color marks and localize its hint/summary lines. */
export type DoctorFormatOptions = {
  /** Decorates the ✗/~/✓ mark (the CLI wraps it in red/yellow/green). */
  mark?: (mark: "✗" | "~" | "✓") => string;
  /** Renders a fix-hint line body; default `→ fix: ${hint}` (TUI wording). */
  fixHint?: (hint: string) => string;
  /** Renders the summary line; default `${passed}/${total} checks passed`. */
  summary?: (passed: number, total: number) => string;
};

/**
 * Renders checks as "✓ name  detail" / "~ name  detail" (warning) / "✗ name
 * detail" (failure) lines plus a final summary, padded so details line up.
 * Fix hints are shown for failures and warnings alike. "passed" counts ✓ AND ~
 * (warnings are non-fatal); only ✗ are failures.
 */
export function formatDoctorLines(checks: DoctorCheck[], opts: DoctorFormatOptions = {}): string[] {
  const markOf = opts.mark ?? ((m) => m);
  const hintOf = opts.fixHint ?? ((hint) => `→ fix: ${hint}`);
  const summaryOf = opts.summary ?? ((passed, total) => `${passed}/${total} checks passed`);
  const width = Math.max(0, ...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    const mark = markOf(!c.ok ? "✗" : c.warn ? "~" : "✓");
    lines.push(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
    if ((!c.ok || c.warn) && c.fixHint) lines.push(`  ${" ".repeat(width)}  ${hintOf(c.fixHint)}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  lines.push(summaryOf(passed, checks.length));
  return lines;
}

// ---------------------------------------------------------------------------
// Optional subsystems.
//
// Every one of these degrades QUIETLY when it is missing: the OS sandbox turns
// a configured `sandbox` into a runtime error on the first command, an absent
// Playwright makes every browser tool unavailable, a missing language server
// turns lsp_* into a "no server" error mid-task, and tree-sitter falling back
// to the regex floor just makes the repo map quietly worse. Doctor checked none
// of them — it checked the updater and the web bundle — so the first sign of
// any of these was a run failing partway through.
//
// All are informational: the agent works without every one of them, so none
// flips the exit code.
// ---------------------------------------------------------------------------

/** Sandbox availability as core's probe reports it, without depending on core. */
export type SandboxProbe = { available: boolean; binary?: string; reason?: string };

export function osSandboxCheck(probe: SandboxProbe, configured: boolean): DoctorCheck {
  if (probe.available) {
    return { name: "os sandbox", ok: true, detail: probe.binary ?? "available" };
  }
  // Unavailable is only a WARNING when the config actually asks for it —
  // run_command then fails with sandbox_unavailable rather than silently
  // running unsandboxed, so this is the difference between finding out now and
  // finding out mid-task.
  return {
    name: "os sandbox",
    ok: true,
    ...(configured ? { warn: true } : {}),
    detail: probe.reason ?? "unavailable",
    ...(configured ? { fixHint: 'install bwrap (linux), or set sandbox to "off" in config.json' } : {}),
  };
}

/**
 * Playwright resolves, so the browser_* tools can start. The probe comes from
 * @seekforge/core (browserBackendInstalled) because that is the package the
 * optional dependency installs into; resolving it from here would report every
 * installation as missing.
 */
export function browserCheck(probe: { available: boolean; specifier: string }): DoctorCheck {
  const { available, specifier } = probe;
  return available
    ? { name: "browser", ok: true, detail: specifier }
    : {
        name: "browser",
        ok: true,
        detail: `${specifier} not installed — browser tools unavailable`,
        fixHint: "pnpm add -w playwright-core && npx playwright install chromium",
      };
}

/** The language servers the lsp_* tools look for, and which are on PATH. */
export const LSP_SERVER_COMMANDS = ["typescript-language-server", "pyright-langserver", "pylsp", "gopls"] as const;

export function lspServersCheck(probes: DoctorProbes): DoctorCheck {
  const found = LSP_SERVER_COMMANDS.filter((bin) => probes.commandExists(bin));
  return found.length > 0
    ? { name: "lsp servers", ok: true, detail: found.join(", ") }
    : {
        name: "lsp servers",
        ok: true,
        detail: "none on PATH — lsp_* tools unavailable",
        fixHint: "npm i -g typescript-language-server typescript (or pyright / gopls for other languages)",
      };
}

/** tree-sitter, which upgrades symbol extraction above the regex floor. */
export function codeParsingCheck(installed: boolean): DoctorCheck {
  return installed
    ? { name: "code parsing", ok: true, detail: "tree-sitter (AST)" }
    : {
        name: "code parsing",
        ok: true,
        detail: "regex floor — tree-sitter not installed, repo_map symbols are approximate",
        fixHint: "pnpm install (web-tree-sitter and tree-sitter-wasms are workspace dependencies)",
      };
}

/** Docker, which only `seekforge sandbox-run` needs. */
export function dockerCheck(probes: DoctorProbes): DoctorCheck {
  return probes.commandExists("docker")
    ? { name: "docker", ok: true, detail: "available (sandbox-run)" }
    : { name: "docker", ok: true, detail: "not installed — `sandbox-run` unavailable" };
}
